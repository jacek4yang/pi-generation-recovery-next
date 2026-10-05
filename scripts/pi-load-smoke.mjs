// Real-Pi load smoke: load this package's extension through the actual Pi SDK
// with a disposable agent home, then assert the extension registered cleanly
// and its command is visible to the extension runtime. Never touches
// ~/.pi/agent or credentials; no model calls are made.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempAgentDir = mkdtempSync(join(tmpdir(), "pi-generation-recovery-smoke-"));

// Isolate resource discovery before the SDK reads any environment.
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

const { createAgentSession, DefaultResourceLoader, SessionManager } =
  await import("@earendil-works/pi-coding-agent");

const probe = { commands: null };
const loader = new DefaultResourceLoader({
  cwd: repoRoot,
  agentDir: tempAgentDir,
  additionalExtensionPaths: [join(repoRoot, "src", "index.ts")],
  extensionFactories: [
    (pi) => {
      pi.on("session_start", () => {
        probe.commands = pi.getCommands().map((c) => c.name);
      });
    },
  ],
});
await loader.reload();

const { errors, warnings } = loader.extensionsResult;
assert.deepEqual(errors, [], `extension load errors: ${JSON.stringify(errors)}`);
console.log(`pi-load-smoke: extensions loaded (${warnings?.length ?? 0} warnings)`);

const { session } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
});

try {
  await session.bindExtensions({ mode: "json" });
  await new Promise((r) => setImmediate(r));
  assert.ok(Array.isArray(probe.commands), "session_start probe never ran");
  assert.ok(
    probe.commands.includes("generation-recovery-next"),
    `generation-recovery-next command missing; got ${JSON.stringify(probe.commands)}`,
  );
  console.log(`pi-load-smoke: commands visible: ${probe.commands.join(", ")}`);
} finally {
  session.dispose();
  rmSync(tempAgentDir, { recursive: true, force: true });
}
console.log("pi-load-smoke OK");
