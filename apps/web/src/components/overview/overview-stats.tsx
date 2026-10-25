"use client";

import { Address } from "@/components/shared/address";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { SkeletonStat } from "@/components/shared/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useApiQuery } from "@/lib/use-api";

export function OverviewStats() {
  const ledger = useApiQuery(() => api.getLedger({ limit: 1 }), []);
  const requests = useApiQuery(() => api.listControllerRequests({ status: "pending" }), []);

  if (ledger.error) return <ErrorState error={ledger.error} title="Could not read the ledger" />;

  const treasury = ledger.data?.balances.find((b) => b.account === "usdc-treasury")?.netAtomic;
  const inEscrow = ledger.data?.balances.find((b) => b.account === "escrow-deposit")?.netAtomic;
  const spent = ledger.data?.balances.find((b) => b.account === "data-expense")?.netAtomic;

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Stat label="Treasury · ledger" loading={ledger.loading}>
        {treasury !== undefined ? <Money atomic={treasury} size="xl" /> : <None />}
        {requests.data?.treasury ? <Address value={requests.data.treasury} className="mt-2" /> : null}
      </Stat>
      <Stat label="In escrow" loading={ledger.loading}>
        {inEscrow !== undefined ? <Money atomic={inEscrow} size="xl" /> : <None />}
      </Stat>
      <Stat label="Spent on data" loading={ledger.loading}>
        {spent !== undefined ? <Money atomic={spent} size="xl" /> : <None />}
        {ledger.data?.departments.length ? (
          <ul className="mt-2 flex flex-col gap-0.5 text-xs text-text-muted">
            {ledger.data.departments.map((d) => (
              <li key={`${d.account}-${d.department}`} className="flex justify-between gap-3">
                <span className="capitalize">{d.department}</span>
                <Money atomic={d.netAtomic} size="sm" unit={null} muted />
              </li>
            ))}
          </ul>
        ) : null}
      </Stat>
    </div>
  );
}

function Stat({ label, loading, children }: { label: string; loading: boolean; children: React.ReactNode }) {
  return (
    <Card className="bg-surface">
      <CardContent className="flex flex-col gap-1 pt-5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">{label}</span>
        {loading ? <SkeletonStat /> : children}
      </CardContent>
    </Card>
  );
}

function None() {
  return <span className="text-sm text-text-muted">no entries</span>;
}
