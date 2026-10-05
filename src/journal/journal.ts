// Append-only recovery journal (JSONL, hash-chained, bounded).
//
// ONE canonical verification path (verifyRecords) is used by load, read and
// GC. A record is accepted only when ALL of the following hold:
//   - valid JSON with the expected record schema;
//   - sequence semantics: n === previous accepted n + 1 (first record n = 1);
//   - prev linkage equals the previous accepted record's hash (first: null);
//   - hash === recordHash(prev, data).
// Anything else ends verification: read() returns ONLY the longest verified
// prefix and the journal is marked degraded. Recovery never acts on records
// beyond the first integrity failure. Appending to a degraded journal throws
// (fail closed); truncateToVerified() is the explicit repair path.
//
// Sequence policy: n is LOCAL to the compacted chain. GC rebuilds the kept
// segment (renumbered from 1) BEFORE serializing — the bytes on disk are
// always the rebuilt chain, never stale records. After GC: open, verify,
// append, close, reopen, verify, append all work.

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface JournalRecord<T = unknown> {
  n: number;
  prev: string | null;
  hash: string;
  data: T;
}

export const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
export const MAX_JOURNAL_RECORDS = 512;

export function recordHash(prev: string | null, data: unknown): string {
  return createHash("sha256")
    .update(`${prev ?? "root"}:${JSON.stringify(data)}`, "utf8")
    .digest("hex");
}

export interface VerifyResult<T = unknown> {
  records: JournalRecord<T>[];
  degraded: boolean;
  error?: string;
  /** True when ONLY the final non-empty line was an incomplete append
   * (crash-tail): every complete preceding record verified. Recoverable. */
  tailTruncated: boolean;
}

/** The single canonical verification path. Never trusts JSON.parse alone. */
export function verifyRecords<T = unknown>(rawLines: string[]): VerifyResult<T> {
  const nonEmpty = rawLines.map((line, lineNo) => ({ line, lineNo: lineNo + 1 })).filter((x) => x.line.trim() !== "");
  const records: JournalRecord<T>[] = [];
  let prevHash: string | null = null;
  let expectedN = 1;

  for (let idx = 0; idx < nonEmpty.length; idx++) {
    const { line, lineNo } = nonEmpty[idx]!;
    const isFinalLine = idx === nonEmpty.length - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Crash consistency (V10): an incomplete FINAL append is recoverable
      // tail truncation — every complete preceding record verified. Invalid
      // JSON anywhere else is hard corruption.
      if (isFinalLine) {
        return {
          records,
          degraded: false,
          tailTruncated: true,
          error: `line ${lineNo}: incomplete final append (recoverable tail truncation)`,
        };
      }
      return {
        records,
        degraded: true,
        tailTruncated: false,
        error: `line ${lineNo}: invalid JSON (hard corruption)`,
      };
    }
    const rec = parsed as Partial<JournalRecord<T>>;
    if (
      typeof rec !== "object" ||
      rec === null ||
      typeof rec.n !== "number" ||
      typeof rec.hash !== "string" ||
      !("data" in rec) ||
      ("prev" in rec && rec.prev !== null && typeof rec.prev !== "string")
    ) {
      return { records, degraded: true, tailTruncated: false, error: `line ${lineNo}: invalid record schema` };
    }
    if (rec.n !== expectedN) {
      return {
        records,
        degraded: true,
        tailTruncated: false,
        error: `line ${lineNo}: sequence break (n=${String(rec.n)}, expected ${expectedN})`,
      };
    }
    if ((rec.prev ?? null) !== prevHash) {
      return { records, degraded: true, tailTruncated: false, error: `line ${lineNo}: prev linkage broken` };
    }
    if (rec.hash !== recordHash(prevHash, rec.data)) {
      return {
        records,
        degraded: true,
        tailTruncated: false,
        error: `line ${lineNo}: hash mismatch (data or hash tampered)`,
      };
    }
    records.push(rec as JournalRecord<T>);
    prevHash = rec.hash;
    expectedN++;
  }
  return { records, degraded: false, tailTruncated: false };
}

export class Journal {
  private file: string;
  private root: string;
  private count = 0;
  private lastHash: string | null = null;
  private bytes = 0;
  private degraded: { error: string } | undefined;
  private maxBytes: number;
  private maxRecords: number;

  constructor(file: string, opts?: { maxBytes?: number; maxRecords?: number }) {
    this.file = file;
    this.root = dirname(file);
    this.maxBytes = opts?.maxBytes ?? MAX_JOURNAL_BYTES;
    this.maxRecords = opts?.maxRecords ?? MAX_JOURNAL_RECORDS;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const text = readFileSync(this.file, "utf8");
    this.bytes = Buffer.byteLength(text, "utf8");
    const { records, degraded, error, tailTruncated } = verifyRecords(text.split("\n"));
    if (tailTruncated) {
      // Recoverable crash-tail (V10): atomically truncate to the exact
      // verified prefix and continue normally — no operator intervention.
      this.write(records);
      return;
    }
    this.count = records.length;
    this.lastHash = records.length > 0 ? records[records.length - 1]!.hash : null;
    if (degraded) this.degraded = { error: error ?? "degraded" };
  }

  isDegraded(): { error: string } | undefined {
    return this.degraded;
  }

  /** Longest cryptographically + structurally verified prefix. */
  read<T>(): JournalRecord<T>[] {
    if (!existsSync(this.file)) return [];
    return verifyRecords<T>(readFileSync(this.file, "utf8").split("\n")).records;
  }

  verify<T>(): VerifyResult<T> {
    if (!existsSync(this.file)) return { records: [], degraded: false, tailTruncated: false };
    return verifyRecords<T>(readFileSync(this.file, "utf8").split("\n"));
  }

  append<T>(data: T): JournalRecord<T> {
    if (this.degraded) {
      throw new Error(
        `JOURNAL_DEGRADED: ${this.degraded.error} — truncateToVerified() before appending`,
      );
    }
    if (this.count >= this.maxRecords || this.bytes > this.maxBytes) {
      this.gc();
    }
    const rec: JournalRecord<T> = {
      n: this.count + 1,
      prev: this.lastHash,
      hash: recordHash(this.lastHash, data),
      data,
    };
    const line = JSON.stringify(rec) + "\n";
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.file, line, "utf8");
    this.count = rec.n;
    this.lastHash = rec.hash;
    this.bytes += Buffer.byteLength(line, "utf8");
    return rec;
  }

  /** Explicit repair path: keep only the verified prefix, renumbered from 1. */
  truncateToVerified(): number {
    const { records } = this.verify();
    this.write(records);
    return records.length;
  }

  /**
   * Deterministic GC: keep the newest half, REBUILD the chain (renumbered
   * from 1 — n is local to the compacted chain), then serialize the rebuilt
   * records. After GC: open, verify, append, close, reopen, verify, append.
   */
  private gc(): void {
    const { records } = this.verify();
    const keep = records.slice(Math.floor(records.length / 2));
    this.write(keep);
  }

  /** Serialize a rebuilt, renumbered chain atomically (tmp + rename). */
  private write(records: JournalRecord[]): void {
    let prevHash: string | null = null;
    let n = 0;
    const lines = records.map((r) => {
      n++;
      const rec: JournalRecord = {
        n,
        prev: prevHash,
        hash: recordHash(prevHash, r.data),
        data: r.data,
      };
      prevHash = rec.hash;
      return JSON.stringify(rec) + "\n";
    });
    const tmp = this.file + ".tmp";
    mkdirSync(this.root, { recursive: true });
    writeFileSync(tmp, lines.join(""), "utf8");
    renameSync(tmp, this.file);
    this.count = records.length;
    // lastHash must be the RECOMPUTED hash of the rebuilt chain, never the
    // stale pre-GC hash (that was the residual bug after the first fix).
    this.lastHash = prevHash;
    this.bytes = Buffer.byteLength(lines.join(""), "utf8");
    this.degraded = undefined;
  }

  static gcSessions(root: string, keepSessions: number): void {
    if (!existsSync(root)) return;
    const files = readdirSync(root)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(root, f));
    const byMtime = files.map((f) => ({ f, m: statSync(f).mtimeMs })).sort((a, b) => b.m - a.m);
    for (const stale of byMtime.slice(keepSessions)) rmSync(stale.f, { force: true });
  }
}
