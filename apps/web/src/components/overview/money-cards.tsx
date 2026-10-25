"use client";

import Link from "next/link";
import type { MissionRecord } from "@overflow/schemas";
import { Address } from "@/components/shared/address";
import { Money } from "@/components/shared/money";
import { SkeletonStat } from "@/components/shared/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { ApiError } from "@/lib/api/client";
import type { TreasuryResponse } from "@/lib/api/contracts";
import type { ApiQueryState } from "@/lib/use-api";

/**
 * Four numbers, each from one source and labelled with it: the treasury's USDC
 * and reservedTotal from the chain at one block, escrow commitment from the
 * orders the indexer confirmed, spend from the books. A card never shows a
 * number its source did not return: it shows the error or "unavailable" instead.
 */
export function MoneyCards({
  treasury,
  spent,
}: {
  treasury: ApiQueryState<TreasuryResponse>;
  spent: { loading: boolean; error: Error | undefined; mission: MissionRecord | undefined; atomic: bigint | undefined };
}) {
  const chain = treasury.data?.chain ?? null;
  const chainNote = treasury.data ? (chain ? `block ${chain.blockNumber}` : (treasury.data.chainUnavailable ?? "chain read unavailable")) : undefined;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Stat label="Treasury · onchain" loading={treasury.loading} error={treasury.error} note={chainNote}>
        {chain ? <Money atomic={chain.balanceAtomic} size="xl" /> : <Unavailable />}
        {treasury.data?.treasury ? <Address value={treasury.data.treasury} className="mt-2" /> : null}
      </Stat>
      <Stat
        label="Escrow committed"
        loading={treasury.loading}
        error={treasury.error}
        note={treasury.data ? `${treasury.data.escrow.fundedOrders} funded of ${treasury.data.escrow.openOrders} open order(s)` : undefined}
      >
        {treasury.data ? <Money atomic={treasury.data.escrow.committedAtomic} size="xl" /> : null}
      </Stat>
      <Stat label="Reserved" loading={treasury.loading} error={treasury.error} note={chain ? "reservedTotal(), counted by the floor check" : chainNote}>
        {chain ? <Money atomic={chain.reservedTotalAtomic} size="xl" /> : <Unavailable />}
      </Stat>
      <Stat label="Spent this mission" loading={spent.loading} error={spent.error} note={spent.mission ? "data-expense booked to its purchases" : "no mission yet"}>
        {spent.atomic !== undefined ? <Money atomic={spent.atomic} size="xl" /> : <span className="text-sm text-text-muted">no mission</span>}
        {spent.mission ? (
          <Link href={`/missions/${encodeURIComponent(spent.mission.id)}`} className="mt-2 truncate text-xs text-text-muted hover:text-cyan" title={spent.mission.goal}>
            {spent.mission.goal}
          </Link>
        ) : null}
      </Stat>
    </div>
  );
}

function Stat({ label, loading, error, note, children }: { label: string; loading: boolean; error: Error | undefined; note?: string | undefined; children: React.ReactNode }) {
  return (
    <Card className="bg-surface">
      <CardContent className="flex min-w-0 flex-col gap-1 pt-5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">{label}</span>
        {loading ? <SkeletonStat /> : error ? <StatError error={error} /> : children}
        {!loading && !error && note ? (
          <span className="mt-1 truncate text-[11px] text-text-muted" title={note}>
            {note}
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatError({ error }: { error: Error }) {
  const api = error instanceof ApiError ? error : null;
  return (
    <div role="alert" className="flex flex-col gap-0.5">
      <span className="text-sm font-medium text-danger">unavailable</span>
      <span className="truncate text-[11px] text-text-muted" title={error.message}>
        {api ? `${api.status} ${api.code}: ` : ""}
        {error.message}
      </span>
    </div>
  );
}

function Unavailable() {
  return <span className="text-sm text-text-muted">unavailable</span>;
}
