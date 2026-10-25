import { Suspense } from "react";
import { PurchaseDetail } from "@/components/purchases/purchase-detail";
import { SkeletonRows } from "@/components/shared/skeleton";

/** One purchase: what will be paid, what the chain confirmed, and why it was chosen. The client reads the id with useParams. */
export default function PurchasePage() {
  return (
    <Suspense fallback={<SkeletonRows rows={6} />}>
      <PurchaseDetail />
    </Suspense>
  );
}
