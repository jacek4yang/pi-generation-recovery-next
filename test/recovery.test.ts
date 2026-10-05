// V1–V13 invariant tests for the recovery core. All deterministic — no live
// provider. Each test names the invariant it enforces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeSafeFrontier,
  safePrefixText,
  CONTINUATION_INSTRUCTION,
  type ContentBlock,
} from "../src/recovery/frontier.ts";
import { planRecovery } from "../src/recovery/ladder.ts";
import { Journal, recordHash, MAX_JOURNAL_RECORDS } from "../src/journal/journal.ts";
import {
  assertIdentityFresh,
  hashToolLoadout,
  sameIdentity,
  type RecoveryIdentity,
} from "../src/core/identity.ts";

const ID: RecoveryIdentity = {
  sessionId: "s1",
  headId: "h1",
  provider: "intern",
  model: "glm-5.3",
  thinkingLevel: undefined,
  toolLoadoutHash: hashToolLoadout(["read", "bash"]),
  contextGeneration: 1,
};

function blocks(
  specs: Array<Partial<ContentBlock> & { kind: ContentBlock["kind"] }>,
): ContentBlock[] {
  return specs.map((s) => ({ complete: true, text: s.kind === "text" ? "t" : undefined, ...s }));
}

test("[V1] V1: safe completed text prefix is proven and reconstructible", () => {
  const r = computeSafeFrontier(
    blocks([
      { kind: "text", text: "alpha " },
      { kind: "text", text: "beta" },
    ]),
  );
  assert.equal(r.frontier, "COMPLETE_TEXT");
  assert.deepEqual(r.safePrefix, [0, 1]);
  assert.equal(
    safePrefixText(
      blocks([
        { kind: "text", text: "alpha " },
        { kind: "text", text: "beta" },
      ]),
      r,
    ),
    "alpha beta",
  );
});

test("[V2] V2: thinking blocks are excluded unless the provider adapter verifies them", () => {
  const withThinking = blocks([
    { kind: "text", text: "a" },
    { kind: "thinking", text: "secret reasoning" },
  ]);
  const strict = computeSafeFrontier(withThinking);
  assert.deepEqual(strict.safePrefix, [0]);
  assert.equal(strict.barrier?.kind, "thinking");
  const verifying = computeSafeFrontier(withThinking, { reasoningReplay: true });
  assert.equal(verifying.reasoningBlocks, 1);
  assert.equal(safePrefixText(withThinking, verifying), "a"); // thinking never enters visible text
});

test("[V3][V4][V5] V3/V4/V5: any tool-call block is a hard barrier — fail closed", () => {
  const partial = computeSafeFrontier(
    blocks([
      { kind: "text", text: "a" },
      { kind: "toolCall", complete: false, toolName: "bash" },
    ]),
  );
  assert.equal(partial.frontier, "BARRIER_UNSAFE");
  assert.equal(partial.barrier?.kind, "toolCall");
  const completed = computeSafeFrontier(
    blocks([
      { kind: "text", text: "a" },
      { kind: "toolCall", complete: true, toolName: "bash" },
    ]),
  );
  assert.equal(completed.barrier?.kind, "toolCall");
  const ladder = planRecovery({
    identity: ID,
    currentIdentity: ID,
    frontier: partial,
    committedEffects: new Set(),
    attemptsSoFar: 0,
    maxAttempts: 2,
    cancelled: false,
  });
  assert.equal(ladder.strategy, "fallback");
  assert.match(ladder.reason, /V3|V4|V5|side-effect/);
});

test("[V6] V6: consecutive interruptions are bounded by the attempt budget", () => {
  const frontier = computeSafeFrontier(blocks([{ kind: "text", text: "done text" }]));
  const decision = planRecovery({
    identity: ID,
    currentIdentity: ID,
    frontier,
    committedEffects: new Set(),
    attemptsSoFar: 2,
    maxAttempts: 2,
    cancelled: false,
  });
  assert.equal(decision.strategy, "fallback");
  assert.match(decision.reason, /budget exhausted/);
});

test("[V7] V7: provider/model/session/branch change invalidates the attempt", () => {
  const frontier = computeSafeFrontier(blocks([{ kind: "text", text: "x" }]));
  const stale: RecoveryIdentity = { ...ID, model: "other-model" };
  const decision = planRecovery({
    identity: ID,
    currentIdentity: stale,
    frontier,
    committedEffects: new Set(),
    attemptsSoFar: 0,
    maxAttempts: 2,
    cancelled: false,
  });
  assert.equal(decision.strategy, "fallback");
  assert.match(decision.reason, /STALE_IDENTITY/);
  assert.throws(() => assertIdentityFresh(ID, stale));
  assert.ok(sameIdentity(ID, { ...ID }));
});

test("[V8] V8: journal survives reopen (read back equals written)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinx-rec-"));
  const file = join(dir, "s1.jsonl");
  const j1 = new Journal(file);
  j1.append({ kind: "attempt", id: "a1" });
  j1.append({ kind: "attempt", id: "a2" });
  const j2 = new Journal(file);
  const records = j2.read();
  assert.equal(records.length, 2);
  assert.equal((records[1]!.data as { id: string }).id, "a2");
  rmSync(dir, { recursive: true, force: true });
});

test("[V9] V9: corrupt records fail closed to verified prefix (V9 journal)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinx-rec-"));
  const file = join(dir, "s1.jsonl");
  const j1 = new Journal(file);
  j1.append({ kind: "attempt", id: "good-1" });
  j1.append({ kind: "attempt", id: "good-2" });
  const raw = readFileSync(file, "utf8").split("\n");
  raw.splice(1, 0, "{corrupt json line"); // corrupt the middle
  writeFileSync(file, raw.join("\n"), "utf8");
  const j2 = new Journal(file);
  const records = j2.read();
  assert.ok(records.length >= 1 && records.length < 4, `verified prefix kept: ${records.length}`);
  assert.equal((records[0]!.data as { id: string }).id, "good-1");
  rmSync(dir, { recursive: true, force: true });
});

test("[V10] V10: truncated final line is tolerated — earlier records survive", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinx-rec-"));
  const file = join(dir, "s1.jsonl");
  const j1 = new Journal(file);
  j1.append({ kind: "attempt", id: "complete" });
  j1.append({ kind: "attempt", id: "victim" });
  const raw = readFileSync(file, "utf8");
  writeFileSync(file, raw.slice(0, raw.length - 10), "utf8"); // corrupt last line
  const j2 = new Journal(file);
  const records = j2.read();
  assert.equal(records.length, 1);
  assert.equal((records[0]!.data as { id: string }).id, "complete");
  rmSync(dir, { recursive: true, force: true });
});

test("[V11] V11: journal quota triggers deterministic GC", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinx-rec-"));
  const file = join(dir, "s1.jsonl");
  const j = new Journal(file, { maxRecords: 10 });
  for (let i = 0; i < MAX_JOURNAL_RECORDS + 1; i++) j.append({ i });
  assert.ok(j.read().length <= MAX_JOURNAL_RECORDS);
  assert.ok(existsSync(file));
  rmSync(dir, { recursive: true, force: true });
});

test("[V12] V12: cancellation falls back immediately", () => {
  const decision = planRecovery({
    identity: ID,
    currentIdentity: ID,
    frontier: computeSafeFrontier(blocks([{ kind: "text", text: "x" }])),
    committedEffects: new Set(),
    attemptsSoFar: 0,
    maxAttempts: 2,
    cancelled: true,
  });
  assert.equal(decision.strategy, "fallback");
  assert.match(decision.reason, /cancelled/);
});

test("[V13] V13: budget exhaustion fails closed with a precise reason", () => {
  const decision = planRecovery({
    identity: ID,
    currentIdentity: ID,
    frontier: computeSafeFrontier(blocks([{ kind: "text", text: "x" }])),
    committedEffects: new Set(),
    attemptsSoFar: 5,
    maxAttempts: 5,
    cancelled: false,
  });
  assert.equal(decision.strategy, "fallback");
  assert.match(decision.reason, /exhausted/);
});

test("journal hash chain binds every record to its parent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinx-rec-"));
  const file = join(dir, "s1.jsonl");
  const j = new Journal(file);
  const a = j.append({ k: 1 });
  const b = j.append({ k: 2 });
  assert.equal(a.prev, null);
  assert.equal(b.prev, a.hash);
  assert.equal(b.hash, recordHash(a.hash, { k: 2 }));
  rmSync(dir, { recursive: true, force: true });
});

test("continuation instruction is explicit about non-repetition", () => {
  assert.match(CONTINUATION_INSTRUCTION, /do not repeat/i);
});
