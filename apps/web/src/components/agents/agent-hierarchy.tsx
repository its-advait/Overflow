"use client";

import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import type { TreasuryNodeView } from "@overflow/schemas";
import { Address } from "@/components/shared/address";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { SkeletonRows } from "@/components/shared/skeleton";
import { SimulatedBadge } from "@/components/shared/simulated-badge";
import { api } from "@/lib/api";
import { buildNodeTree } from "@/lib/tree";
import { useApiQuery, useLastGood } from "@/lib/use-api";
import type { RequestMode } from "./agent-menu";
import { AgentPanel } from "./agent-panel";
import { AgentTree } from "./agent-tree";
import { RequestDialog } from "./request-dialog";

/** Feed kinds after which the tree and the request list are re-read from the service. */
const RELOAD_KINDS = new Set<string>([
  "treasury.paid",
  "treasury.node",
  "treasury.policy",
  "controller.requested",
  "controller.submitted",
  "controller.resolved",
  "policy.blocked",
]);
const DEBOUNCE_MS = 300;
const POLL_MS = 15_000;

/**
 * The delegation tree with live budgets. Data comes from GET /api/treasury/nodes (view calls on the
 * treasury) and GET /api/controller-requests; the SSE feed only says *when* to re-read. A paused or
 * expired ancestor greys out its subtree because the service derives the status the way settle() does.
 */
export function AgentHierarchy() {
  const tree = useApiQuery(() => api.listTreasuryNodes(), []);
  const requests = useApiQuery(() => api.listControllerRequests({ status: "all" }), []);
  const [version, setVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [dialog, setDialog] = useState<{ mode: RequestMode; node: TreasuryNodeView } | null>(null);

  // Keep the last good tree while a refetch is in flight so bars animate instead of flashing to a skeleton.
  const data = useLastGood(tree.data);
  const requestRows = useLastGood(requests.data)?.requests ?? [];

  const reloadTree = tree.reload;
  const reloadRequests = requests.reload;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        reloadTree();
        reloadRequests();
        setVersion((v) => v + 1);
      }, DEBOUNCE_MS);
    };
    const unsubscribe = api.subscribe((m) => {
      if (m.type === "activity" && RELOAD_KINDS.has(m.event.kind)) bump();
    });
    const poll = setInterval(bump, POLL_MS);
    return () => {
      unsubscribe();
      clearInterval(poll);
      if (timer) clearTimeout(timer);
    };
  }, [reloadTree, reloadRequests]);

  if (!data) {
    if (tree.error) return <ErrorState error={tree.error} title="Could not read the treasury's nodes" />;
    return <SkeletonRows rows={5} />;
  }

  const roots = buildNodeTree(data.nodes);
  const selected = selectedId === null ? null : (data.nodes.find((n) => n.id === selectedId) ?? null);

  return (
    <div className="flex flex-col gap-4" data-testid="agent-hierarchy" data-simulated={data.simulated}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
        <span className="flex items-center gap-1">
          treasury <Address value={data.treasury} chars={5} />
        </span>
        <span>
          block <span className="tnum text-text">{data.blockNumber}</span>
        </span>
        <span>as of {new Date(data.asOf).toLocaleTimeString()}</span>
        <span>
          {data.nodes.length} node{data.nodes.length === 1 ? "" : "s"} · allowlist {data.allowlist.length}
        </span>
        {data.simulated ? <SimulatedBadge what="treasury: browser model, no chain" /> : null}
        {tree.error ? <span className="text-danger">refresh failed: {tree.error.message} (showing the last successful read)</span> : null}
      </div>

      {roots.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="The treasury has no nodes yet"
          description="createRoot has not been called on this treasury. The tree appears when the first NodeCreated event is indexed and getNode(1) answers."
        />
      ) : (
        <AgentTree
          roots={roots}
          requests={requestRows}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
          onAction={(node, mode) => setDialog({ mode, node })}
        />
      )}

      <AgentPanel node={selected} version={version} onClose={() => setSelectedId(null)} />
      <RequestDialog
        target={dialog}
        onClose={() => setDialog(null)}
        onSubmitted={() => {
          reloadRequests();
          setVersion((v) => v + 1);
        }}
      />
    </div>
  );
}
