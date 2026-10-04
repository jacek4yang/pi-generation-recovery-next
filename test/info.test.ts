import { test } from "node:test";
import assert from "node:assert/strict";
import { STACK_INFO } from "../src/info.ts";

test("customTypes live in the pinx namespace", () => {
  for (const t of Object.values(STACK_INFO.customTypes)) {
    assert.ok(t.startsWith("pinx.recovery."), t);
  }
});

test("state root is isolated from the stable stack", () => {
  assert.equal(STACK_INFO.stateRoot, "pinx/generation-recovery-next");
});
