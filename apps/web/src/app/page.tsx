import { Construction } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { OverviewStats } from "@/components/overview/overview-stats";

/**
 * Overview. The stat cards read the ledger and the mission through the typed
 * client; everything else waits for its own prompt. Nothing on this page is a
 * local flag: balances come from GET /api/ledger (or the MOCK fixtures).
 */
export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        description="Treasury balance, budget utilization and what the agents are doing right now."
      />
      <OverviewStats />
      <EmptyState
        className="mt-6"
        icon={Construction}
        title="Activity, Blocked lane and agent tree land in later prompts"
        description="Each will read confirmed chain events and service responses only."
      />
    </>
  );
}
