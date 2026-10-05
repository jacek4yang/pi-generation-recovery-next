// Runtime-outcome adapter boundary: generation-recovery must be able to ask
// "did this tool operation durably commit?" without importing code-runtime
// internals. The default probe is maximally conservative: unknown — and
// unknown side-effect state fails closed (never replay, never regenerate
// blindly). code-runtime-next can later provide a real probe backed by its
// durable execution journal; core correctness never depends on it.

export type ExecutionOutcomeState =
  "not-started" | "started" | "completed-with-durable-result" | "failed" | "cancelled" | "unknown";

export interface RuntimeOutcomeProbe {
  /** Durable outcome for one tool operation id. Must never infer from
   * assistant text; only durable runtime state may answer. */
  outcome(toolCallId: string): ExecutionOutcomeState;
}

/** Fail-closed default: every effect is "unknown". */
export const CONSERVATIVE_PROBE: RuntimeOutcomeProbe = {
  outcome: () => "unknown",
};

/** The only states that make a completed effect safe to NOT re-execute. */
export function durablyResolved(state: ExecutionOutcomeState): boolean {
  return state === "completed-with-durable-result" || state === "failed" || state === "cancelled";
}
