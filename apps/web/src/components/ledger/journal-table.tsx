"use client";

import Link from "next/link";
import type { FinancialEntry, LedgerAccount } from "@overflow/schemas";
import { TxHash } from "@/components/shared/address";
import { EmptyState } from "@/components/shared/empty-state";
import { Money } from "@/components/shared/money";
import { formatWhen } from "@/components/shared/panel";
import { Pill } from "@/components/shared/status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMemo } from "@/lib/format-memo";
import { ACCOUNT_STYLE, ACCOUNTS, entryKind } from "@/lib/ledger/accounts";
import { isSplitLine, type JournalFilter } from "@/lib/ledger/journal";

const SELECT = "h-9 min-w-48 rounded-lg border border-border bg-surface px-3 text-sm text-text";

/**
 * The journal: one row per double-entry line the service booked from a confirmed
 * chain event. Filters are sent to GET /api/ledger (account matches either side).
 * Every row links to its purchase and its transaction on Basescan.
 */
export function JournalTable({
  entries,
  departments,
  filter,
  onFilter,
  truncated,
}: {
  entries: readonly FinancialEntry[];
  /** Departments known to the books (from the whole-book department balances). */
  departments: readonly string[];
  filter: JournalFilter;
  onFilter: (next: JournalFilter) => void;
  /** True when the server's limit may have cut the list. */
  truncated: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Account
          <select
            className={SELECT}
            value={filter.account ?? ""}
            onChange={(e) => onFilter({ ...filter, account: (e.target.value || undefined) as LedgerAccount | undefined })}
          >
            <option value="">All accounts</option>
            {ACCOUNTS.map((a) => (
              <option key={a} value={a}>
                {ACCOUNT_STYLE[a].label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Department
          <select className={SELECT} value={filter.department ?? ""} onChange={(e) => onFilter({ ...filter, department: e.target.value || undefined })}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <span className="pb-2 text-xs text-text-muted">
          {entries.length} row{entries.length === 1 ? "" : "s"}
          {truncated ? ", newest first (list capped)" : ", newest first"}
        </span>
      </div>

      {entries.length === 0 ? (
        <EmptyState title="No journal entries" description="Entries are posted only from confirmed chain events. Nothing matches this filter yet." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <Table className="min-w-[1080px] table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Date</TableHead>
                <TableHead className="w-[136px]">Event</TableHead>
                <TableHead>Memo</TableHead>
                <TableHead className="w-[120px]">Debit</TableHead>
                <TableHead className="w-[144px]">Credit</TableHead>
                <TableHead className="w-[112px] text-right">Amount</TableHead>
                <TableHead className="w-[104px]">Purchase</TableHead>
                <TableHead className="w-[132px]">Tx</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => {
                const kind = entryKind(e);
                return (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-xs text-text-muted">{formatWhen(e.postedAt)}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-1">
                        <Pill tone={kind.tone}>{kind.label}</Pill>
                        {e.department ? (
                          <Pill tone="muted" title={isSplitLine(e) ? "Fusion split line: one department's share of one chain event" : "Department line"}>
                            {e.department}
                            {isSplitLine(e) ? " · split" : ""}
                          </Pill>
                        ) : null}
                        {e.correctsEntryId ? <Pill tone="violet" title={`Corrects entry ${e.correctsEntryId}`}>correction</Pill> : null}
                      </span>
                    </TableCell>
                    <TableCell className="truncate text-sm text-text" title={e.memo}>
                      {formatMemo(e.memo)}
                    </TableCell>
                    <TableCell className="truncate text-sm" title={ACCOUNT_STYLE[e.debitAccount].label}>{ACCOUNT_STYLE[e.debitAccount].label}</TableCell>
                    <TableCell className="truncate text-sm text-text-muted" title={ACCOUNT_STYLE[e.creditAccount].label}>{ACCOUNT_STYLE[e.creditAccount].label}</TableCell>
                    <TableCell className="tnum text-right">
                      <Money atomic={e.amountAtomic} size="sm" />
                    </TableCell>
                    <TableCell className="truncate text-sm">
                      {e.purchaseId ? (
                        <Link href={`/purchases/${encodeURIComponent(e.purchaseId)}`} title={e.purchaseId} className="font-mono text-xs text-blue hover:underline">
                          {e.purchaseId}
                        </Link>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </TableCell>
                    <TableCell className="overflow-hidden">{e.txHash ? <TxHash value={e.txHash} chars={4} /> : <span className="text-xs text-text-muted">no tx</span>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
