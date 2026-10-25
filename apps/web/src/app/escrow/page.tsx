import { Suspense } from "react";
import { EscrowList } from "@/components/escrow/escrow-list";
import { SkeletonRows } from "@/components/shared/skeleton";
import { NAV } from "@/components/shell/nav";
import { PageHeader } from "@/components/shell/page-header";

const item = NAV.find((n) => n.href === "/escrow")!;

/** Escrow: every per-order escrow; each row opens the order's state diagram, sample, evidence and gates. */
export default function EscrowPage() {
  return (
    <>
      <PageHeader title={item.label} description={item.description} />
      <Suspense fallback={<SkeletonRows rows={6} />}>
        <EscrowList />
      </Suspense>
    </>
  );
}
