// Extension-level event-flow tests: every case drives the ACTUAL registered
// Pi callbacks through the mock registration adapter — the tests never call
// computeSafeFrontier/planRecovery directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pinx-recovery-flow-"));
process.env.PINX_RECOVERY_MAX_ATTEMPTS = "2";

const { default: recoverExtension } = await import("../src/index.ts");
const { CONTINUATION_INSTRUCTION } = await import("../src/recovery/frontier.ts");

const harness = () => {
  const h = createHarnessSafe();
  recoverExtension(h.pi as never);
  return h;
};

function createHarnessSafe() {
  // local import to avoid circular const hoisting issues
  const mod = require0();
  return mod();
}

// tsx supports dynamic import; keep the helper trivial
import { createMockPi } from "./helpers/mock-pi.ts";
function require0() {
  return createMockPi;
}

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
