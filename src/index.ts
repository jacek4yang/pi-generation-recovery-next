import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { STACK_INFO } from "./info.ts";
import { Journal, type JournalRecord } from "./journal/journal.ts";
import {
  computeSafeFrontier,
  safePrefixText,
  CONTINUATION_INSTRUCTION,
  type ContentBlock,
} from "./recovery/frontier.ts";
import { planRecovery, DEFAULT_LADDER_POLICY } from "./recovery/ladder.ts";
import { hashToolLoadout, assertIdentityFresh, type RecoveryIdentity } from "./core/identity.ts";

/**
 * pi-generation-recovery-next — provider-neutral generation recovery.
 *
 * feat/recovery-core: capture interrupted generations (message_end with
 * stopReason aborted/error), compute the safe completed frontier, decide via
 * the bounded ladder, and inject the verified prefix through the `context`
 * event. Authorization: a pending attempt applies only when its identity is
 * fresh (session/head/provider/model/tools); anything else fails closed to
 * Pi's default retry (V7). Side-effecting tool calls are never part of the
 * prefix (V3/V4/V5). Attempts are bounded (V6/V13).
 */
export default function piGenerationRecoveryNext(pi: ExtensionAPI) {
  const mode = (process.env.PINX_RECOVERY ?? "on").toLowerCase();
  const active = mode === "on";
  const shadow = mode === "shadow";
  const maxAttempts = Number(process.env.PINX_RECOVERY_MAX_ATTEMPTS ?? 2) || 2;

  interface PendingAttempt {
    attemptId: string;
    identity: RecoveryIdentity;
    prefixText: string;
    injected: boolean;
    attempts: number;
  }

  let journal: Journal | undefined;
  let sessionId = "";
  let pending: PendingAttempt | undefined;

  const journalFor = (session: string): Journal => {
    if (!journal)
      journal = new Journal(join(getAgentDir(), STACK_INFO.stateRoot, `${session}.jsonl`));
    return journal;
  };

  const currentIdentity = (
    ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  ): RecoveryIdentity => ({
    sessionId: ctx.sessionManager.getSessionId() ?? "",
    headId: ctx.sessionManager.getLeafId() ?? "",
    provider: ctx.model?.provider ?? "",
    model: ctx.model?.id ?? "",
    thinkingLevel: ctx.thinkingLevel,
    toolLoadoutHash: hashToolLoadout(pi.getActiveTools()),
    contextGeneration: 0,
  });

  const emit = (state: string, extra?: Record<string, unknown>): void => {
    try {
      pi.events.emit("pinx.recovery", { v: 1, state, ...extra });
    } catch {
      // observability is best-effort
    }
  };

  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId() ?? "";
    pending = undefined; // a reopen invalidates live attempts (V8: journal persists)
    journal = undefined;
  });

  // Capture: a finalized assistant message that did not complete normally.
  pi.on("message_end", (event, ctx) => {
    const message = event.message as
      | {
          role?: string;
          stopReason?: string;
          content?: Array<{ type: string; text?: string; toolName?: string }>;
        }
      | undefined;
    if (message?.role !== "assistant") return;
    if (message.stopReason !== "aborted" && message.stopReason !== "error") {
      if (
        pending?.injected &&
        (message.stopReason === "stop" || message.stopReason === "toolUse")
      ) {
        journalFor(sessionId).append({
          kind: "disposition",
          attemptId: pending.attemptId,
          outcome: "recovered",
        });
        pending = undefined;
        emit("recovered");
      }
      return;
    }
    if (!active && !shadow) return;
    const identity = currentIdentity(ctx);
    if (!identity.sessionId) return;
    const blocks: ContentBlock[] = (message.content ?? []).map((block) => ({
      kind:
        block.type === "toolCall" ? "toolCall" : block.type === "thinking" ? "thinking" : "text",
      complete: true, // message_end is finalized
      text: block.text,
      toolName: (block as { toolName?: string }).toolName,
    }));
    const frontier = computeSafeFrontier(blocks);
    const attemptId = `att_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    journalFor(sessionId).append({
      kind: "attempt",
      attemptId,
      identity,
      frontier: frontier.frontier,
      safePrefix: frontier.safePrefix,
      stopReason: message.stopReason,
      visibleTextChars: frontier.visibleTextChars,
    });
    if (shadow) return;
    pending = {
      attemptId,
      identity,
      prefixText: safePrefixText(blocks, frontier),
      injected: false,
      attempts: 0,
    };
    emit("captured", { attemptId, frontier: frontier.frontier, chars: frontier.visibleTextChars });
  });

  // Any identity-relevant change invalidates the live attempt (V7).
  const invalidate = () => {
    if (pending) {
      emit("invalidated", { attemptId: pending.attemptId });
      pending = undefined;
    }
  };
  pi.on("model_select", invalidate);
  pi.on("thinking_level_select", invalidate);
  pi.on("session_tree", invalidate);

  // Injection through the context event — the only model-visible surface.
  pi.on("context", (event, ctx) => {
    if (!pending || pending.injected) return { messages: event.messages };
    const identity = currentIdentity(ctx);
    const decision = planRecovery(
      {
        identity: pending.identity,
        currentIdentity: identity,
        frontier: {
          frontier: "COMPLETE_TEXT",
          safePrefix: [],
          visibleTextChars: pending.prefixText.length,
          reasoningBlocks: 0,
        },
        committedEffects: new Set(),
        attemptsSoFar: pending.attempts,
        maxAttempts,
        cancelled: false,
      },
      DEFAULT_LADDER_POLICY,
    );
    if (decision.strategy !== "prefix-continuation") {
      emit("fallback", { attemptId: pending.attemptId, reason: decision.reason });
      journalFor(sessionId).append({
        kind: "disposition",
        attemptId: pending.attemptId,
        outcome: "fallback",
        reason: decision.reason,
      });
      pending = undefined;
      return { messages: event.messages };
    }
    try {
      assertIdentityFresh(pending.identity, identity);
    } catch {
      emit("fallback", { attemptId: pending.attemptId, reason: "stale identity" });
      pending = undefined;
      return { messages: event.messages };
    }
    pending.injected = true;
    pending.attempts++;
    emit("recovering", {
      attemptId: pending.attemptId,
      chars: pending.prefixText.length,
      attempt: pending.attempts,
    });
    return {
      messages: [
        ...event.messages,
        {
          role: "user" as const,
          content: `${CONTINUATION_INSTRUCTION}

--- verified completed prefix ---
${pending.prefixText}`,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.registerCommand("generation-recovery-next", {
    description: "Show recovery state and journal statistics",
    handler: async (_args, ctx) => {
      const records: JournalRecord[] = journal ? journal.read() : [];
      const attempts = records.filter(
        (r) => (r.data as { kind?: string }).kind === "attempt",
      ).length;
      const recovered = records.filter(
        (r) =>
          (r.data as { kind?: string }).kind === "disposition" &&
          (r.data as { outcome?: string }).outcome === "recovered",
      ).length;
      await ctx.ui.notify(
        [
          `pi-generation-recovery-next ${STACK_INFO.contractVersion} · mode ${mode}`,
          `journal: ${attempts} attempts · ${recovered} recovered · pending: ${pending ? pending.attemptId : "none"}`,
          "safe completed frontier only; side effects never implicitly replayed",
        ].join("\n"),
        "info",
      );
    },
  });
}
