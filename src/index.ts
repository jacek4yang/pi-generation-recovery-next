import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { STACK_INFO } from "./info.ts";

/**
 * pi-generation-recovery-next — experimental provider-neutral generation
 * recovery with narrowly scoped provider replay adapters.
 *
 * Bootstrap entry (main): status command only. The coordinator, safe-prefix
 * analysis, and provider adapters land on feature branches
 * (feat/recovery-coordinator, feat/<provider>-safe-prefix-adapter).
 */
export default function piGenerationRecoveryNext(pi: ExtensionAPI) {
  pi.registerCommand("generation-recovery-next", {
    description: "Show pi-generation-recovery-next stack status",
    handler: async (_args, ctx) => {
      await ctx.ui.notify(
        "pi-generation-recovery-next " +
          STACK_INFO.contractVersion +
          ": bootstrap (features land on feature branches)",
        "info",
      );
    },
  });
}
