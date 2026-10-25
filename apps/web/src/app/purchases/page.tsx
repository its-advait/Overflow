import { Suspense } from "react";
import { PurchasesView } from "@/components/purchases/purchases-view";
import { SkeletonRows } from "@/components/shared/skeleton";
import { PageHeader } from "@/components/shell/page-header";

/** Purchases: Oracle recommendations, Fusion merges and the authorization each agent signed. Client data only; nothing here is a local flag. */
export default function PurchasesPage() {
  return (
    <>
      <PageHeader title="Purchases" description="Oracle recommendations, Fusion merges and the authorization each agent signed." />
      <Suspense fallback={<SkeletonRows rows={4} />}>
        <PurchasesView />
      </Suspense>
    </>
  );
}
