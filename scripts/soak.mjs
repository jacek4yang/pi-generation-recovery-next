// Deterministic soak harness: drives the REAL extension event path through
// many interrupt/recover/complete cycles, asserting no unbounded growth and
// no duplicate recovery. Reports the actual duration honestly.
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUDGET_MS = Number(process.env.PINX_SOAK_MS ?? 60_000);
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pinx-soak-home-"));
process.env.PINX_RECOVERY_MAX_ATTEMPTS = "2";

const { default: recoverExtension } = await import("../src/index.ts");
const { createMockPi } = await import("../test/helpers/mock-pi.ts");

const h = createMockPi();
recoverExtension(h.pi);
await h.dispatch("session_start", { reason: "startup" });

const interrupted = {
  role: "assistant", stopReason: "aborted",
  content: [{ type: "text", text: "Investigation complete. The bug is in " + "x".repeat(200) }],
};
const completed = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Fixed." }] };

let cycles = 0;
let recoverings = 0;
let fallbacks = 0;
const started = performance.now();
while (performance.now() - started < BUDGET_MS) {
  await h.dispatch("message_end", { message: interrupted });
  await h.dispatch("context", { messages: [] });
  await h.dispatch("message_end", { message: completed });
  cycles++;
  const states = h.busLog.filter((e) => e.channel === "pinx.recovery").map((e) => e.payload.state);
  recoverings = states.filter((s) => s === "recovered").length;
  fallbacks = states.filter((s) => s === "fallback").length;
}
const durationMs = Math.round(performance.now() - started);
const journalDir = join(process.env.PI_CODING_AGENT_DIR, "pinx", "generation-recovery-next");
let journalBytes = 0;
if (existsSync(journalDir)) {
  for (const f of (await import("node:fs")).readdirSync(journalDir)) {
    journalBytes += statSync(join(journalDir, f)).size;
  }
}
const busEvents = h.busLog.filter((e) => e.channel === "pinx.recovery").length;

console.log(JSON.stringify({
  soak: "recovery event-path soak (deterministic, no provider)",
  duration_ms: durationMs,
  cycles,
  recovered: recoverings,
  fallbacks,
  bus_events: busEvents,
  journal_bytes: journalBytes,
  appended_entries: h.appendedEntries.length,
  assertions: {
    every_cycle_recovered: recoverings === cycles,
    no_retry_storm: fallbacks === 0,
    journal_bounded: journalBytes < 10 * 1024 * 1024,
  },
}, null, 2));
rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true });
