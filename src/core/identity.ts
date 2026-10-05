// Identity binding (V7): a recovery attempt is valid only for the exact
// session/branch/provider/model/tool-loadout/context-generation it captured.
// Any mismatch fails closed to Pi's default retry behavior.

import { createHash } from "node:crypto";

export interface RecoveryIdentity {
  sessionId: string;
  /** Leaf entry the interrupted generation hangs from. */
  headId: string;
  provider: string;
  model: string;
  thinkingLevel: string | undefined;
  /** Hash of the declared tool loadout (names sorted, joined). */
  toolLoadoutHash: string;
  /** Monotonic context generation owned by the context lifecycle. */
  contextGeneration: number;
}

export function identityKey(identity: RecoveryIdentity): string {
  return [
    identity.sessionId,
    identity.headId,
    identity.provider,
    identity.model,
    identity.thinkingLevel ?? "-",
    identity.toolLoadoutHash,
    identity.contextGeneration,
  ].join("|");
}

export function sameIdentity(a: RecoveryIdentity, b: RecoveryIdentity): boolean {
  return identityKey(a) === identityKey(b);
}

export function hashToolLoadout(toolNames: readonly string[]): string {
  return createHash("sha256")
    .update([...toolNames].sort().join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** Strict equality check used before any replay decision (V7). */
export function assertIdentityFresh(captured: RecoveryIdentity, current: RecoveryIdentity): void {
  if (!sameIdentity(captured, current)) {
    throw new Error(
      `STALE_IDENTITY: captured ${identityKey(captured)} != current ${identityKey(current)}`,
    );
  }
}
