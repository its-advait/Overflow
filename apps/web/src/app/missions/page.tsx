import { Suspense } from "react";
import { MissionsView } from "@/components/missions/missions-view";
import { SkeletonRows } from "@/components/shared/skeleton";
import { PageHeader } from "@/components/shell/page-header";

/** Missions: compose one, then review what the Oracle extracted before anything is bought. Client data only. */
export default function MissionsPage() {
  return (
    <>
      <PageHeader title="Missions" description="Compose a mission, extract its requirements and follow its purchases." />
      <Suspense fallback={<SkeletonRows rows={4} />}>
        <MissionsView />
      </Suspense>
    </>
  );
}
