import type { FinancialEntry, LedgerAccount } from "@overflow/schemas";

export interface JournalFilter {
  account?: LedgerAccount | undefined;
  department?: string | undefined;
  purchaseId?: string | undefined;
}

/** The server's predicate, mirrored for the mock client and tests: an account matches either side of the row. */
export function filterEntries(entries: readonly FinancialEntry[], filter: JournalFilter): FinancialEntry[] {
  return entries.filter(
    (e) =>
      (!filter.purchaseId || e.purchaseId === filter.purchaseId) &&
      (!filter.account || e.debitAccount === filter.account || e.creditAccount === filter.account) &&
      (!filter.department || e.department === filter.department),
  );
}

/** Departments that appear on any row, sorted. */
export function departmentsOf(entries: readonly FinancialEntry[]): string[] {
  return [...new Set(entries.flatMap((e) => (e.department ? [e.department] : [])))].sort();
}

/** A department line of a Fusion split: the posting rule writes `<eventKey>#<department>`. */
export function isSplitLine(entry: Pick<FinancialEntry, "sourceEventId" | "eventKey">): boolean {
  return entry.sourceEventId !== entry.eventKey && entry.sourceEventId.includes("#");
}

/** Newest first, then by sourceEventId so split lines of one event stay together. */
export function newestFirst(entries: readonly FinancialEntry[]): FinancialEntry[] {
  return [...entries].sort((a, b) => b.postedAt.localeCompare(a.postedAt) || b.sourceEventId.localeCompare(a.sourceEventId));
}
