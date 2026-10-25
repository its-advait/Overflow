import { AgentHierarchy } from "@/components/agents/agent-hierarchy";
import { NAV } from "@/components/shell/nav";
import { PageHeader } from "@/components/shell/page-header";

const item = NAV.find((n) => n.href === "/agents")!;

/**
 * Agents: the delegation tree read from the treasury (root, children, grandchildren) with each
 * node's cap, spend, remaining(), per-call limit, expiry, payees and status, the per-node
 * controller menu and a side panel of payments and refusals. Mock or live follows
 * NEXT_PUBLIC_USE_MOCKS like every other page.
 */
export default function AgentsPage() {
  return (
    <>
      <PageHeader title={item.label} description={item.description} />
      <AgentHierarchy />
    </>
  );
}
