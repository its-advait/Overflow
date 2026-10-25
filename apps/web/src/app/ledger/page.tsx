import { Suspense } from "react";
import { LedgerView } from "@/components/ledger/ledger-view";
import { SkeletonRows } from "@/components/shared/skeleton";
import { PageHeader } from "@/components/shell/page-header";

/** Ledger: the fictional company's double-entry books (SIMULATED company; entries come only from confirmed chain events), reconciled against Base Sepolia. */
export default function LedgerPage() {
  return (
    <>
      <PageHeader
        title="Ledger"
        description="Fictional company books, reconciled against the chain."
      />
      <Suspense fallback={<SkeletonRows rows={6} />}>
        <LedgerView />
      </Suspense>
    </>
  );
}
