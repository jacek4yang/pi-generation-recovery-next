// Narrow journal semantic boundary (reliability brief, strengthening area 1):
// the ONLY place journal integrity failures are converted into recovery
// state. Known integrity/degraded failures (JOURNAL_DEGRADED, hash/prev/
// sequence/chain breaks) are contained: the caller receives undefined,
// pending recovery is cleared, and a journal-corrupt event is emitted.
// Unexpected programming errors are rethrown — genuine bugs stay visible.
// Hard-corrupt bytes are never modified and nothing is ever replayed.

import type { Journal } from "../journal/journal.ts";

export interface JournalBoundaryDeps {
  journal: () => Journal;
  onCorrupt: (info: { reason: string }) => void;
  /** Clears any pending recovery that depends on the (now untrusted) state. */
  clearPending: () => void;
}

const INTEGRITY_RE =
  /^JOURNAL_DEGRADED|hash mismatch|prev linkage|sequence break|chain|verified prefix|invalid record schema|invalid JSON \(hard corruption\)/i;

export function isJournalIntegrityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return INTEGRITY_RE.test(message);
}

/**
 * Run a journal operation inside the semantic boundary. Returns the
 * operation result, or undefined when an integrity failure was contained
 * (onCorrupt has run; caller must not continue recovery from corrupt state).
 */
export function journalBoundary<T>(
  deps: JournalBoundaryDeps,
  operation: (journal: Journal) => T,
): T | undefined {
  try {
    return operation(deps.journal());
  } catch (error) {
    if (!isJournalIntegrityError(error)) throw error;
    deps.onCorrupt({ reason: error instanceof Error ? error.message : String(error) });
    deps.clearPending();
    return undefined;
  }
}
