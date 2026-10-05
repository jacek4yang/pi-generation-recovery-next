// Append-only recovery journal (JSONL, hash-chained, bounded).
// V9 (corruption), V10 (truncated tail tolerated), V11 (quota + GC),
// V8 (reopen = read back). One file per session; records reference stable
// generation ids and never contain provider secrets.

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

export class Journal {
  private file: string;
  private root: string;
  private count = 0;
  private lastHash: string | null = null;
  private bytes = 0;

  constructor(file: string, opts?: { maxBytes?: number; maxRecords?: number }) {
    this.file = file;
    this.root = dirname(file);
    this.maxBytes = opts?.maxBytes ?? MAX_JOURNAL_BYTES;
    this.maxRecords = opts?.maxRecords ?? MAX_JOURNAL_RECORDS;
    this.load();
  }

  private maxBytes: number;
  private maxRecords: number;

  private load(): void {
    if (!existsSync(this.file)) return;
    const text = readFileSync(this.file, "utf8");
    this.bytes = Buffer.byteLength(text, "utf8");
    // V10: a truncated/corrupt final record is discarded; earlier records survive.
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as JournalRecord;
        this.count = rec.n;
        this.lastHash = rec.hash;
      } catch {
        break; // partial/corrupt tail — stop reading, keep what verified
      }
    }
  }

  append<T>(data: T): JournalRecord<T> {
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

  read(): JournalRecord[] {
    if (!existsSync(this.file)) return [];
    const out: JournalRecord[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as JournalRecord);
      } catch {
        break;
      }
    }
    return out;
  }

  /** Deterministic GC: drop the oldest half of records when bounds are hit. */
  private gc(): void {
    const records = this.read();
    if (records.length < 2) return;
    const keep = records.slice(Math.floor(records.length / 2));
    const lines = keep.map((r) => JSON.stringify(r) + "\n").join("");
    // Re-anchor the chain after GC: first kept record becomes the new root.
    for (let i = 0; i < keep.length; i++) {
      const prev = i === 0 ? null : keep[i - 1]!.hash;
      keep[i]!.prev = prev;
      keep[i]!.hash = recordHash(prev, keep[i]!.data);
    }
    const tmp = this.file + ".gc.tmp";
    writeFileSync(tmp, lines, "utf8");
    rmSync(this.file, { force: true });
    renameSafe(tmp, this.file);
    this.count = keep.length;
    this.lastHash = keep[keep.length - 1]!.hash ?? null;
    this.bytes = Buffer.byteLength(lines, "utf8");
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

function renameSafe(from: string, to: string): void {
  renameSync(from, to);
}
