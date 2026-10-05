// Bounded recovery ladder (V6/V7/V12/V13): at most maxAttempts recoveries per
// generation; each rung must prove safety before it is used; any identity
// change invalidates the attempt; exhaustion falls back to Pi's own retry
// behavior with a precise reason — never a guess, never a retry storm.

import type { RecoveryIdentity } from "../core/identity.ts";
import { assertIdentityFresh } from "../core/identity.ts";
import type { FrontierResult } from "./frontier.ts";

export type LadderStrategy =
  "native-continuation" | "prefix-continuation" | "regeneration" | "fallback";

export interface LadderInput {
  identity: RecoveryIdentity;
  currentIdentity: RecoveryIdentity;
  frontier: FrontierResult;
  /** Adapter-verified provider continuation state (opaque), if offered. */
  providerContinuation?: { kind: string; payload: unknown };
  /** Durable proof that a previous tool effect committed, keyed by toolCallId. */
  committedEffects: ReadonlySet<string>;
  attemptsSoFar: number;
  maxAttempts: number;
  cancelled: boolean;
}

export type LadderDecision =
  | { strategy: "prefix-continuation"; reason: string; prefixBlocks: number[] }
  | { strategy: "fallback"; reason: string };

export interface LadderPolicy {
  /** Adapter-claimed capability; default false (provider-neutral core). */
  nativeContinuation: boolean;
}

export const DEFAULT_LADDER_POLICY: LadderPolicy = { nativeContinuation: false };

export function planRecovery(
  input: LadderInput,
  policy: LadderPolicy = DEFAULT_LADDER_POLICY,
): LadderDecision {
  if (input.cancelled) {
    return { strategy: "fallback", reason: "recovery cancelled (V12)" };
  }
  if (input.attemptsSoFar >= input.maxAttempts) {
    return {
      strategy: "fallback",
      reason: `retry budget exhausted (${input.attemptsSoFar}/${input.maxAttempts}) (V13)`,
    };
  }
  try {
    assertIdentityFresh(input.identity, input.currentIdentity);
  } catch (e) {
    return { strategy: "fallback", reason: `${(e as Error).message} (V7)` };
  }
  const frontier = input.frontier;
  if (frontier.safePrefix.length === 0) {
    return {
      strategy: "fallback",
      reason: `no proven safe prefix (frontier=${frontier.frontier}) (V1)`,
    };
  }
  if (frontier.barrier?.kind === "toolCall") {
    // V3/V4/V5: a partial or completed tool call is a hard barrier unless the
    // runtime can PROVE the effect never committed — proven effects are reused
    // durably, never replayed here.
    const unproven = true; // v1 core: no idempotency oracle exists yet
    if (unproven) {
      return {
        strategy: "fallback",
        reason: "tool-call boundary: side-effect state unproven — fail closed (V3/V4/V5)",
      };
    }
  }
  // Provider-native continuation stays behind the adapter capability; the
  // neutral core never assumes it (provider neutrality, V2 default off).
  if (policy.nativeContinuation && input.providerContinuation) {
    return {
      strategy: "prefix-continuation",
      reason: "native continuation via provider adapter",
      prefixBlocks: frontier.safePrefix,
    };
  }
  return {
    strategy: "prefix-continuation",
    reason: `proven text prefix of ${frontier.visibleTextChars} chars, ${frontier.reasoningBlocks} verified reasoning blocks`,
    prefixBlocks: frontier.safePrefix,
  };
}
