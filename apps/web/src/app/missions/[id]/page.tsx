import { Suspense } from "react";
import { MissionDetail } from "@/components/missions/mission-detail";
import { SkeletonRows } from "@/components/shared/skeleton";

/** One mission: requirements to review, agent progress, recommendations, purchases, outputs and its activity. The client reads the id with useParams. */
export default function MissionPage() {
  return (
    <Suspense fallback={<SkeletonRows rows={6} />}>
      <MissionDetail />
    </Suspense>
  );
}
