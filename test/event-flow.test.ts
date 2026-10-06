// Extension-level event-flow tests: every case drives the ACTUAL registered
// Pi callbacks through the mock registration adapter — the tests never call
// computeSafeFrontier/planRecovery directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pinx-recovery-flow-"));
process.env.PINX_RECOVERY_MAX_ATTEMPTS = "2";

const { default: recoverExtension } = await import("../src/index.ts");
const { CONTINUATION_INSTRUCTION } = await import("../src/recovery/frontier.ts");

const harness = (opts: { agentDir?: string; sessionId?: string } = {}) => {
  if (opts.agentDir) {
    process.env.PI_CODING_AGENT_DIR = opts.agentDir; // shared reopen dir
  } else {
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pinx-recovery-flow-"));
  }
  const h = createMockPi({ ...opts, agentDir: process.env.PI_CODING_AGENT_DIR });
  recoverExtension(h.pi as never);
  return h;
};

import { createMockPi } from "./helpers/mock-pi.ts";

const interruptedAssistant = {
  role: "assistant",
  stopReason: "aborted",
  content: [{ type: "text", text: "Investigation complete. The bug is in" }],
};

function busStates(h: { busLog: Array<{ channel: string; payload: unknown }> }): string[] {
  return h.busLog
    .filter((e) => e.channel === "pinx.recovery")
    .map((e) => (e.payload as { state: string }).state);
}

function journalPath(h: { sessionId: string }): string {
  return join(
    process.env.PI_CODING_AGENT_DIR!,
    "pinx",
    "generation-recovery-next",
    `${h.sessionId}.jsonl`,
  );
}

test("EVENT FLOW: interrupted → captured → context injection → completion → recovered", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("message_end", { message: interruptedAssistant });
  assert.ok(busStates(h).includes("captured"));
  assert.ok(existsSync(journalPath(h)), "journal written at capture");

  const results = await h.dispatch("context", {
    messages: [{ role: "user", content: "find the bug", timestamp: 1 }, interruptedAssistant],
  });
  const injected = (results[0] as { messages: Array<{ content: string }> }).messages.at(
    -1,
  )!.content;
  assert.match(injected, /Investigation complete\. The bug is in/);
  assert.match(injected, /Continue seamlessly/);
  assert.ok(busStates(h).includes("recovering"));

  // Next assistant completion confirms recovery.
  await h.dispatch("message_end", {
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: " src/x.ts. Fixed." }],
    },
  });
  assert.ok(busStates(h).includes("recovered"));
  h.cleanup();
});

test("EVENT FLOW: normal completed generation does nothing (zero-cost path)", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("message_end", {
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
  });
  await h.dispatch("context", { messages: [] });
  assert.equal(busStates(h).length, 0);
  h.cleanup();
});

test("EVENT FLOW: thinking block only → fallback, no injection (V2)", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("message_end", {
    message: {
      role: "assistant",
      stopReason: "aborted",
      content: [{ type: "thinking", thinking: "hidden reasoning" }],
    },
  });
  const results = await h.dispatch("context", { messages: [] });
  assert.equal(busStates(h).includes("recovering"), false);
  assert.equal(busStates(h).includes("fallback"), true);
  const last = (results[0] as { messages: unknown[] }).messages;
  assert.equal(last.length, 0); // nothing injected
  h.cleanup();
});

test("EVENT FLOW: tool call in interrupted content → barrier, no injection (V3/V4/V5)", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("message_end", {
    message: {
      role: "assistant",
      stopReason: "aborted",
      content: [
        { type: "text", text: "running build" },
        { type: "toolCall", toolName: "bash" },
      ],
    },
  });
  const results = await h.dispatch("context", { messages: [] });
  assert.equal(busStates(h).includes("recovering"), false);
  const last = (results[0] as { messages: unknown[] }).messages;
  assert.equal(last.length, 0);
  h.cleanup();
});

test("EVENT FLOW: model change invalidates pending attempt (V7)", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("message_end", { message: interruptedAssistant });
  h.setTools(["read", "edit", "bash"]);
  await h.dispatch("model_select", { provider: "other", modelId: "m2" });
  await h.dispatch("context", { messages: [] });
  assert.equal(busStates(h).includes("recovering"), false);
  assert.ok(busStates(h).includes("invalidated") || busStates(h).includes("fallback"));
  h.cleanup();
});

test("EVENT FLOW: thinking-level change invalidates pending attempt", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("message_end", { message: interruptedAssistant });
  await h.dispatch("thinking_level_select", { level: "high" });
  await h.dispatch("context", { messages: [] });
  assert.equal(busStates(h).includes("recovering"), false);
  h.cleanup();
});

test("EVENT FLOW: session-tree change invalidates pending attempt", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("message_end", { message: interruptedAssistant });
  await h.dispatch("session_tree", { newLeafId: "other" });
  await h.dispatch("context", { messages: [] });
  assert.equal(busStates(h).includes("recovering"), false);
  h.cleanup();
});

test("EVENT FLOW: tool-loadout change invalidates pending attempt", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("message_end", { message: interruptedAssistant });
  h.setTools(["read", "edit", "bash", "pinx_recall"]);
  const results = await h.dispatch("context", { messages: [] });
  assert.equal(busStates(h).includes("recovering"), false);
  const last = (results[0] as { messages: unknown[] }).messages;
  assert.equal(last.length, 0);
  h.cleanup();
});

test("EVENT FLOW: attempt budget exhausts after two recoveries (V6/V13)", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  // Chain interruptions WITHOUT an intervening successful completion —
  // the chained attempt budget must stop the loop (V6/V13).
  for (let cycle = 0; cycle < 4; cycle++) {
    await h.dispatch("message_end", { message: interruptedAssistant });
    await h.dispatch("context", { messages: [] });
  }
  const recovering = busStates(h).filter((s) => s === "recovering").length;
  assert.ok(recovering <= 2, `recovering happened ${recovering} times (budget 2)`);
  h.cleanup();
});

test("EVENT FLOW: successful recovery then a second interruption recovers again", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("message_end", { message: interruptedAssistant });
  await h.dispatch("context", { messages: [] });
  await h.dispatch("message_end", {
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "continued" }],
    },
  });
  assert.ok(busStates(h).includes("recovered"));

  // A second interruption starts a fresh attempt.
  await h.dispatch("message_end", {
    message: {
      role: "assistant",
      stopReason: "aborted",
      content: [{ type: "text", text: "Second finding:" }],
    },
  });
  const results = await h.dispatch("context", { messages: [] });
  const injected = (results[0] as { messages: Array<{ content: string }> }).messages.at(
    -1,
  )!.content;
  assert.match(injected, /Second finding:/);
  h.cleanup();
});

test("EVENT FLOW: shadow mode journals but never injects", async () => {
  process.env.PINX_RECOVERY = "shadow";
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("message_end", { message: interruptedAssistant });
  const results = await h.dispatch("context", { messages: [] });
  assert.equal(busStates(h).includes("recovering"), false);
  const last = (results[0] as { messages: unknown[] }).messages;
  assert.equal(last.length, 0);
  assert.ok(existsSync(journalPath(h)), "shadow still journals");
  delete process.env.PINX_RECOVERY;
  h.cleanup();
});

test("EVENT FLOW: disabled mode does nothing at all", async () => {
  process.env.PINX_RECOVERY = "off";
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("message_end", { message: interruptedAssistant });
  await h.dispatch("context", { messages: [] });
  assert.equal(busStates(h).length, 0);
  assert.equal(existsSync(journalPath(h)), false);
  delete process.env.PINX_RECOVERY;
  h.cleanup();
});

test("EVENT FLOW: no partial-text capture without message_end (documented API limitation)", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  // Stream dies mid-text: Pi delivers message_update, never message_end.
  await h.dispatch("message_update", {
    message: {
      role: "assistant",
      stopReason: "pending",
      content: [{ type: "text", text: "partial tha" }],
    },
  });
  await h.dispatch("context", { messages: [] });
  assert.equal(busStates(h).includes("captured"), false);
  assert.equal(existsSync(journalPath(h)), false);
  h.cleanup();
});

test("EVENT FLOW: injection content contains the continuation instruction once", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("message_end", { message: interruptedAssistant });
  const results = await h.dispatch("context", { messages: [] });
  const injected = (results[0] as { messages: Array<{ content: string }> }).messages.at(
    -1,
  )!.content;
  assert.equal(injected.split(CONTINUATION_INSTRUCTION).length - 1, 1);
  h.cleanup();
});

test("[V9-containment] hard journal corruption cannot escape the callback or inject", async () => {
  // Instance A journals one attempt; the committed record is then tampered
  // with (valid JSON, broken integrity). Instance B is a genuine reopen over
  // the same agent dir + session — the corrupted journal must be contained.
  const sharedAgentDir = mkdtempSync(join(tmpdir(), "pinx-recovery-shared-"));
  const h1 = harness({ agentDir: sharedAgentDir });
  await h1.dispatch("session_start", { reason: "startup" });
  await h1.dispatch("message_end", { message: interruptedAssistant });
  const journalFile = journalPath(h1);
  const { readFileSync, writeFileSync } = await import("node:fs");
  const lines = readFileSync(journalFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  lines[0].data.tampered = true; // keep old hash → integrity failure on reopen
  writeFileSync(journalFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  h1.disposeWithoutCleanup();

  const h = harness({ agentDir: sharedAgentDir, sessionId: h1.sessionId });
  await h.dispatch("session_start", { reason: "resume" });
  await h.dispatch("message_end", { message: interruptedAssistant });
  const states = busStates(h);
  assert.ok(
    states.includes("journal-corrupt"),
    `journal-corrupt expected, got ${states.join(",")}`,
  );
  assert.equal(
    states.includes("captured"),
    false,
    "no capture may be journaled from corrupt state",
  );

  const results = await h.dispatch("context", { messages: [] });
  const last = (results[0] as { messages: unknown[] }).messages;
  assert.equal(last.length, 0, "no continuation injection from corrupt journal");

  // Hard-corrupt bytes remain untouched (no auto-truncation of verified corruption).
  const after = readFileSync(journalFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal((after[0].data as { tampered?: boolean }).tampered, true);
  h.cleanup();
});

test("[V7-context] context-generation change invalidates pending recovery", async () => {
  const h = harness();
  h.pi.events.on("pinx.context.status", () => {}); // producer may exist; bus is passive here
  // Simulate the public bus signal from pi-context-manager.
  await h.dispatch("session_start", { reason: "startup" });
  h.pi.events.emit("pinx.context.status", { v: 1, generation: 3 });
  await h.dispatch("message_end", { message: interruptedAssistant });
  // Generation unchanged so far — recovery proceeds.
  let results = await h.dispatch("context", { messages: [] });
  assert.ok(
    (results[0] as { messages: unknown[] }).messages.length > 0,
    "recovery injects under the same generation",
  );
  await h.dispatch("message_end", {
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "continued" }],
    },
  });

  // New interruption, then the generation ADVANCES before injection.
  await h.dispatch("message_end", { message: interruptedAssistant });
  h.pi.events.emit("pinx.context.status", { v: 1, generation: 4 });
  results = await h.dispatch("context", { messages: [] });
  assert.equal(
    busStates(h).includes("invalidated"),
    true,
    "generation change invalidates pending recovery",
  );
  h.cleanup();
});
