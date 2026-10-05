// Safe completed frontier (V1–V5): which content blocks of an interrupted
// assistant generation are PROVEN complete and safe to continue from.
//
// Rules (from the invariant table):
//   - text blocks that reached message_end are complete; a tool-call block is
//     NEVER safe (V4/V5: side effects must never be implicitly replayed);
//   - thinking blocks are safe only when a provider adapter verifies them (V2);
//   - the safe prefix must be contiguous — the first unsafe block is a barrier
//     and everything after it is dropped (fail closed, V3).

export type BlockKind = "text" | "thinking" | "toolCall";

export interface ContentBlock {
  kind: BlockKind;
  complete: boolean;
  /** For toolCall blocks: whether execution was proven committed. */
  executionProven?: boolean;
  text?: string;
  toolName?: string;
}

export type Frontier =
  | "NOTHING_RECEIVED"
  | "COMPLETE_TEXT"
  | "PARTIAL_TOOL_CALL"
  | "COMPLETE_TOOL_CALL"
  | "BARRIER_UNSAFE";

export interface FrontierResult {
  frontier: Frontier;
  /** Contiguous safe prefix block indices (all proven complete). */
  safePrefix: number[];
  /** First unsafe block that terminated the prefix, if any. */
  barrier?: { index: number; kind: BlockKind };
  visibleTextChars: number;
  /** Provider-verified reasoning blocks included in the prefix. */
  reasoningBlocks: number;
}

export interface FrontierPolicy {
  /** Whether the provider adapter can verify/legally replay thinking blocks. */
  reasoningReplay: boolean;
}

export const DEFAULT_POLICY: FrontierPolicy = { reasoningReplay: false };

export function computeSafeFrontier(
  blocks: ContentBlock[],
  policy: FrontierPolicy = DEFAULT_POLICY,
): FrontierResult {
  const safePrefix: number[] = [];
  let visibleTextChars = 0;
  let reasoningBlocks = 0;
  let barrier: { index: number; kind: BlockKind } | undefined;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.kind === "toolCall") {
      // Tool calls are never part of a recoverable prefix: a completed call
      // would risk duplicate side effects; a partial call must never execute.
      barrier = { index: i, kind: block.kind };
      break;
    }
    if (block.kind === "thinking") {
      if (block.complete && policy.reasoningReplay) {
        safePrefix.push(i);
        reasoningBlocks++;
        continue;
      }
      barrier = { index: i, kind: block.kind };
      break;
    }
    // text
    if (!block.complete) {
      barrier = { index: i, kind: block.kind };
      break;
    }
    safePrefix.push(i);
    visibleTextChars += (block.text ?? "").length;
  }

  let frontier: Frontier;
  if (barrier) {
    frontier = "BARRIER_UNSAFE";
  } else if (safePrefix.length === 0) {
    frontier = "NOTHING_RECEIVED";
  } else {
    frontier = "COMPLETE_TEXT";
  }
  return { frontier, safePrefix, barrier, visibleTextChars, reasoningBlocks };
}

/** Reconstruct the proven-safe assistant text (V1) — thinking excluded by default. */
export function safePrefixText(blocks: ContentBlock[], result: FrontierResult): string {
  return result.safePrefix
    .filter((i) => blocks[i]!.kind === "text")
    .map((i) => blocks[i]!.text ?? "")
    .join("");
}

export const CONTINUATION_INSTRUCTION =
  "[recovery] The previous response was interrupted. The verified completed portion of that response follows below. Continue seamlessly from exactly where it ends — do not repeat the completed text, do not restate what already happened.";
