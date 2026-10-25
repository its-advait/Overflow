import { Suspense } from "react";
import { EscrowDetail } from "@/components/escrow/escrow-detail";
import { SkeletonRows } from "@/components/shared/skeleton";

/** One escrow order: state diagram, terms with live countdowns, sample, evidence and the calls the contract would accept. The client reads the id with useParams. */
export default function EscrowOrderPage() {
  return (
    <Suspense fallback={<SkeletonRows rows={8} />}>
      <EscrowDetail />
    </Suspense>
  );
}
