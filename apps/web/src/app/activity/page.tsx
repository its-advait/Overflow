import { Suspense } from "react";
import { ActivityView } from "@/components/activity/activity-view";
import { SkeletonRows } from "@/components/shared/skeleton";
import { NAV } from "@/components/shell/nav";
import { PageHeader } from "@/components/shell/page-header";

const item = NAV.find((n) => n.href === "/activity")!;

/** Activity: every event in order, the Blocked lane with decoded reasons, and a drawer per event. */
export default function ActivityPage() {
  return (
    <>
      <PageHeader title={item.label} description={item.description} />
      <Suspense fallback={<SkeletonRows rows={6} />}>
        <ActivityView />
      </Suspense>
    </>
  );
}
