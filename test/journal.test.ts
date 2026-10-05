// Journal integrity suite — every corruption/verification behavior from the
// reliability brief, against the single canonical verification path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, recordHash } from "../src/journal/journal.ts";

function tmpFile(): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pinx-journal-"));
  return { file: join(dir, "s.jsonl"), dir };
}

function tamperLine(
  file: string,
  index: number,
  mutate: (rec: Record<string, unknown>) => unknown,
): void {
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const rec = JSON.parse(lines[index]!) as Record<string, unknown>;
  lines[index] = JSON.stringify(mutate(rec));
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

test("valid hash chain verifies cleanly", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file);
  j.append({ a: 1 });
  j.append({ a: 2 });
  const v = j.verify();
  assert.equal(v.degraded, false);
  assert.equal(v.records.length, 2);
  assert.equal(v.records[1]!.prev, v.records[0]!.hash);
  assert.equal(v.records[1]!.hash, recordHash(v.records[0]!.hash, { a: 2 }));
  rmSync(dir, { recursive: true, force: true });
});

test("tampered data with syntactically valid JSON is detected (V9)", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file);
  j.append({ op: "bash", cmd: "rm -rf /" });
  j.append({ op: "bash", cmd: "echo ok" });
  tamperLine(file, 0, (rec) => ({ ...rec, data: { op: "bash", cmd: "echo safe" } }));
  const v = new Journal(file).verify();
  assert.equal(v.degraded, true);
  assert.match(v.error!, /hash mismatch/);
  assert.equal(v.records.length, 0); // first line is the tampered one
  rmSync(dir, { recursive: true, force: true });
});

test("tampered hash is detected", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file);
  j.append({ a: 1 });
  tamperLine(file, 0, (rec) => ({ ...rec, hash: "0".repeat(64) }));
  const v = new Journal(file).verify();
  assert.equal(v.degraded, true);
  assert.equal(v.records.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("tampered prev is detected", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file);
  j.append({ a: 1 });
  j.append({ a: 2 });
  tamperLine(file, 1, (rec) => ({ ...rec, prev: "b".repeat(64) }));
  const v = new Journal(file).verify();
  assert.equal(v.degraded, true);
  assert.equal(v.records.length, 1); // first record still verifies
  rmSync(dir, { recursive: true, force: true });
});

test("record deletion (sequence break) is detected", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file);
  j.append({ a: 1 });
  j.append({ a: 2 });
  j.append({ a: 3 });
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  writeFileSync(file, [lines[0], lines[2]].join("\n") + "\n", "utf8"); // drop middle
  const v = new Journal(file).verify();
  assert.equal(v.degraded, true);
  assert.match(v.error!, /sequence break/);
  rmSync(dir, { recursive: true, force: true });
});

test("record insertion (duplicate n) is detected", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file);
  j.append({ a: 1 });
  const lines = readFileSync(file, "utf8").trim().split("\n");
  writeFileSync(file, [lines[0], lines[0]].join("\n") + "\n", "utf8"); // duplicate n=1
  const v = new Journal(file).verify();
  assert.equal(v.degraded, true);
  assert.match(v.error!, /sequence break/);
  rmSync(dir, { recursive: true, force: true });
});

test("record reorder is detected", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file);
  j.append({ a: 1 });
  j.append({ a: 2 });
  const lines = readFileSync(file, "utf8").trim().split("\n");
  writeFileSync(file, [lines[1], lines[0]].join("\n") + "\n", "utf8");
  const v = new Journal(file).verify();
  assert.equal(v.degraded, true);
  rmSync(dir, { recursive: true, force: true });
});

test("middle corruption keeps the verified prefix", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file);
  j.append({ id: "good-1" });
  j.append({ id: "good-2" });
  j.append({ id: "good-3" });
  const lines = readFileSync(file, "utf8").split("\n");
  lines[1] = "{corrupt";
  writeFileSync(file, lines.join("\n"), "utf8");
  const v = new Journal(file).verify();
  assert.equal(v.degraded, true);
  assert.equal(v.records.length, 1);
  assert.equal((v.records[0]!.data as { id: string }).id, "good-1");
  rmSync(dir, { recursive: true, force: true });
});

test("truncated final line degrades but keeps earlier records (V10)", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file);
  j.append({ id: "complete" });
  j.append({ id: "victim" });
  const raw = readFileSync(file, "utf8");
  writeFileSync(file, raw.slice(0, raw.length - 10), "utf8");
  const v = new Journal(file).verify();
  assert.equal(v.degraded, true);
  assert.equal(v.records.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("append to a degraded journal throws (fail closed)", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file);
  j.append({ a: 1 });
  j.append({ a: 2 });
  tamperLine(file, 0, (rec) => ({ ...rec, data: { a: "tampered" } }));
  const degraded = new Journal(file);
  assert.ok(degraded.isDegraded());
  assert.throws(() => degraded.append({ a: 3 }), /JOURNAL_DEGRADED/);
  rmSync(dir, { recursive: true, force: true });
});

test("truncateToVerified repairs the chain and renumbers from 1", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file);
  j.append({ a: 1 });
  j.append({ a: 2 });
  j.append({ a: 3 });
  tamperLine(file, 2, (rec) => ({ ...rec, data: { a: "tampered" } }));
  const degraded = new Journal(file);
  const kept = degraded.truncateToVerified();
  assert.equal(kept, 2);
  const v = new Journal(file).verify();
  assert.equal(v.degraded, false);
  assert.equal(v.records.length, 2);
  assert.equal(v.records[0]!.n, 1);
  assert.equal(v.records[1]!.n, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("GC then reopen verifies the rebuilt chain (renumbered from 1)", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file, { maxRecords: 4 });
  for (let i = 1; i <= 5; i++) j.append({ i });
  const j2 = new Journal(file);
  const v = j2.verify();
  assert.equal(v.degraded, false, `GC chain broken: ${v.error}`);
  assert.equal(v.records[0]!.n, 1);
  assert.equal(v.records[0]!.prev, null);
  rmSync(dir, { recursive: true, force: true });
});

test("GC then append keeps sequence semantics", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file, { maxRecords: 4 });
  for (let i = 1; i <= 5; i++) j.append({ i });
  const j2 = new Journal(file);
  j2.append({ i: 6 });
  const v = new Journal(file).verify();
  assert.equal(v.degraded, false);
  const last = v.records[v.records.length - 1]!;
  assert.equal((last.data as { i: number }).i, 6);
  assert.equal(last.n, v.records[v.records.length - 2]!.n + 1);
  rmSync(dir, { recursive: true, force: true });
});

test("repeated GC cycles stay verifiable", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file, { maxRecords: 4 });
  for (let i = 1; i <= 12; i++) j.append({ i });
  const v = new Journal(file).verify();
  assert.equal(v.degraded, false);
  assert.ok(v.records.length <= 4);
  rmSync(dir, { recursive: true, force: true });
});

test("empty journal verifies as empty and is not degraded", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file);
  const v = j.verify();
  assert.equal(v.degraded, false);
  assert.equal(v.records.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("single-record journal verifies", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file);
  j.append({ only: true });
  const v = new Journal(file).verify();
  assert.equal(v.degraded, false);
  assert.equal(v.records.length, 1);
  assert.equal(v.records[0]!.prev, null);
  rmSync(dir, { recursive: true, force: true });
});

test("restart after GC verifies (open/verify/append/close/reopen/verify/append)", () => {
  const { file, dir } = tmpFile();
  const a = new Journal(file, { maxRecords: 4 });
  for (let i = 1; i <= 5; i++) a.append({ i });
  const b = new Journal(file);
  assert.equal(b.verify().degraded, false);
  b.append({ i: 6 });
  const c = new Journal(file);
  const v = c.verify();
  assert.equal(v.degraded, false);
  c.append({ i: 7 });
  assert.equal(new Journal(file).verify().records.length, v.records.length + 1);
  rmSync(dir, { recursive: true, force: true });
});

test("maxBytes boundary triggers GC instead of unbounded growth (V11)", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file, { maxBytes: 4096 });
  for (let i = 1; i <= 200; i++) j.append({ payload: "x".repeat(100) });
  assert.ok(existsSync(file));
  const size = readFileSync(file, "utf8").length;
  assert.ok(size <= 4096 + 8192, `journal grew to ${size} bytes`);
  assert.equal(new Journal(file).verify().degraded, false);
  rmSync(dir, { recursive: true, force: true });
});

test("maxRecords boundary triggers GC (V11)", () => {
  const { file, dir } = tmpFile();
  const j = new Journal(file, { maxRecords: 10 });
  for (let i = 1; i <= 50; i++) j.append({ i });
  assert.ok(new Journal(file).read().length <= 10);
  rmSync(dir, { recursive: true, force: true });
});
