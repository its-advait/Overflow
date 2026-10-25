import { Suspense } from "react";
import { LedgerView } from "@/components/ledger/ledger-view";
import { SimulatedBadge } from "@/components/shared/simulated-badge";
import { SkeletonRows } from "@/components/shared/skeleton";
import { PageHeader } from "@/components/shell/page-header";

/** Ledger: the fictional company's double-entry books (SIMULATED company; entries come only from confirmed chain events), reconciled against Base Sepolia. */
export default function LedgerPage() {
  return (
    <>
      <PageHeader
        title="Ledger"
        description="Double-entry journal booked from confirmed chain events, balances by account and department with the Fusion split, reconciliation of the chain against the books, and the exceptions a human must decide."
        actions={<SimulatedBadge what="company books: the company and its departments are fictional; the entries follow real chain events" />}
      />
      <Suspense fallback={<SkeletonRows rows={6} />}>
        <LedgerView />
      </Suspense>
    </>
  );
}
