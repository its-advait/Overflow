"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorState } from "@/components/shared/error-state";
import { SkeletonRows } from "@/components/shared/skeleton";
import { api } from "@/lib/api";
import type { JournalFilter } from "@/lib/ledger/journal";
import { useApiQuery } from "@/lib/use-api";
import { cn } from "@/lib/utils";
import { BalancesPanel } from "./balances-panel";
import { ExceptionsList, type ExceptionsFilter } from "./exceptions-list";
import { JournalTable } from "./journal-table";
import { ReconciliationPanel } from "./reconciliation-panel";

const VIEWS = ["journal", "balances", "reconciliation", "exceptions"] as const;
type View = (typeof VIEWS)[number];
const LABELS: Record<View, string> = { journal: "Journal", balances: "Balances", reconciliation: "Reconciliation", exceptions: "Exceptions" };
const JOURNAL_LIMIT = 500;

/** Activity kinds after which the books, the last run or the exception list may have changed. */
const REFRESH_KINDS = new Set([
  "usdc.transfer", "escrow.funded", "escrow.settled", "escrow.refunded", "escrow.bond-forfeited",
  "reconciliation.ok", "reconciliation.difference", "exception.opened", "controller.requested", "controller.resolved",
]);

/**
 * /ledger: the books the way a controller reads them. Four views behind
 * `?view=`: the journal (GET /api/ledger with account/department filters), the
 * balances with the Fusion breakdown, the reconciliation panel
 * (GET /api/reconciliation) and the exceptions list (GET /api/exceptions).
 * Everything shown came from a service response; nothing is a local flag.
 */
export function LedgerView() {
  const params = useSearchParams();
  const requested = params.get("view");
  const view: View = (VIEWS as readonly string[]).includes(requested ?? "") ? (requested as View) : "journal";

  const [filter, setFilter] = useState<JournalFilter>({});
  const [exceptionsFilter, setExceptionsFilter] = useState<ExceptionsFilter>("open");

  const ledger = useApiQuery(() => api.getLedger({ limit: JOURNAL_LIMIT, account: filter.account, department: filter.department }), [filter.account, filter.department]);
  const reconciliation = useApiQuery(() => api.getReconciliation(), []);
  const exceptions = useApiQuery(() => api.listExceptions({ status: exceptionsFilter }), [exceptionsFilter]);

  // Live updates: the indexer posts entries and runs reconciliation after new logs; refetch, debounced.
  const reloadLedger = ledger.reload;
  const reloadRecon = reconciliation.reload;
  const reloadExceptions = exceptions.reload;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.subscribe((m) => {
      if (m.type !== "activity" || !REFRESH_KINDS.has(m.event.kind)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        reloadLedger();
        reloadRecon();
        reloadExceptions();
      }, 300);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [reloadLedger, reloadRecon, reloadExceptions]);

  const refreshAll = () => {
    reloadLedger();
    reloadRecon();
    reloadExceptions();
  };

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Ledger views" className="inline-flex w-fit rounded-lg border border-border bg-surface p-1">
        {VIEWS.map((v) => (
          <Link
            key={v}
            href={v === "journal" ? "/ledger" : `/ledger?view=${v}`}
            aria-current={v === view ? "page" : undefined}
            className={cn("rounded-md px-3 py-1.5 text-sm transition-colors", v === view ? "bg-surface-raised text-text" : "text-text-muted hover:text-text")}
          >
            {LABELS[v]}
            {v === "exceptions" && reconciliation.data?.openExceptions.length ? (
              <span className="ml-1.5 rounded-full bg-warning/15 px-1.5 text-[10px] font-medium text-warning">{reconciliation.data.openExceptions.length}</span>
            ) : null}
          </Link>
        ))}
      </nav>

      {view === "journal" ? (
        ledger.error ? (
          <ErrorState error={ledger.error} title="Could not read the ledger" />
        ) : ledger.loading || !ledger.data ? (
          <SkeletonRows rows={6} />
        ) : (
          <JournalTable
            entries={ledger.data.entries}
            departments={ledger.data.departments.map((d) => d.department)}
            filter={filter}
            onFilter={setFilter}
            truncated={ledger.data.entries.length >= JOURNAL_LIMIT}
          />
        )
      ) : null}

      {view === "balances" ? (
        ledger.error ? (
          <ErrorState error={ledger.error} title="Could not read the ledger" />
        ) : ledger.loading || !ledger.data ? (
          <SkeletonRows rows={6} />
        ) : (
          <BalancesPanel balances={ledger.data.balances} departments={ledger.data.departments} allocations={ledger.data.allocations} />
        )
      ) : null}

      {view === "reconciliation" ? (
        reconciliation.error ? (
          <ErrorState error={reconciliation.error} title="Could not read the reconciliation state" />
        ) : reconciliation.loading || !reconciliation.data ? (
          <SkeletonRows rows={5} />
        ) : (
          <ReconciliationPanel lastRun={reconciliation.data.lastRun} note={reconciliation.data.note} openExceptions={reconciliation.data.openExceptions} onRan={refreshAll} />
        )
      ) : null}

      {view === "exceptions" ? (
        exceptions.error ? (
          <ErrorState error={exceptions.error} title="Could not list exceptions" />
        ) : exceptions.loading || !exceptions.data ? (
          <SkeletonRows rows={3} />
        ) : (
          <ExceptionsList exceptions={exceptions.data.exceptions} filter={exceptionsFilter} onFilter={setExceptionsFilter} onDecided={refreshAll} />
        )
      ) : null}
    </div>
  );
}
