import { CreateMissionAction, OverviewView } from "@/components/overview/overview-view";
import { PageHeader } from "@/components/shell/page-header";

/**
 * Overview: four questions at a glance. What agents are doing (missions with a
 * progress strip, the latest events), how much they can spend (onchain treasury
 * balance, reservedTotal), what is being bought (escrow committed, spent this
 * mission) and whether the money is safe (blocked events in the danger color with
 * their reason). Everything comes from the typed client: GET /api/treasury,
 * /api/missions(/:id), /api/ledger, /api/activity, or the MOCK fixtures.
 */
export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        description="Treasury balance, budget utilization and what the agents are doing right now."
        actions={<CreateMissionAction />}
      />
      <OverviewView />
    </>
  );
}
