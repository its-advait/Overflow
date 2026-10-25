"use client";

import { api } from "@/lib/api";
import { useApiQuery } from "@/lib/use-api";
import { Money } from "@/components/shared/money";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The treasury's USDC per the ledger (`usdc-treasury` net balance from GET /api/ledger).
 * There is no balance route; this is the books, labelled as such. Nothing is fabricated
 * when the call fails: the slot shows the error instead of a number.
 */
export function TreasuryBalance() {
  const ledger = useApiQuery(() => api.getLedger({ limit: 1 }), []);
  const net = ledger.data?.balances.find((b) => b.account === "usdc-treasury")?.netAtomic;
  return (
    <div className="flex flex-col items-end leading-none">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">Treasury · ledger</span>
      {ledger.loading ? (
        <Skeleton className="mt-1 h-5 w-24" />
      ) : ledger.error ? (
        <span className="mt-1 text-xs text-danger" title={ledger.error.message}>
          unavailable
        </span>
      ) : net !== undefined ? (
        <Money atomic={net} size="sm" signed className="mt-0.5" />
      ) : (
        <span className="mt-1 text-xs text-text-muted">no entries</span>
      )}
    </div>
  );
}
