"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { ErrorState } from "@/components/shared/error-state";
import { Simulated } from "@/components/shared/simulated-badge";
import { SkeletonRows } from "@/components/shared/skeleton";
import { StatusPill } from "@/components/shared/status-pill";
import { PageHeader } from "@/components/shell/page-header";
import { api } from "@/lib/api";
import { attachDecisions } from "@/lib/purchases/group";
import { recallProposal } from "@/lib/purchases/propose-cache";
import { useApiQuery } from "@/lib/use-api";
import { FusionProposal, StoredFusionSummary } from "./fusion-proposal";
import { PaymentTimeline } from "./payment-timeline";
import { PurchaseAuthorization } from "./purchase-authorization";
import { ResourceComparison } from "./resource-comparison";
import { agentLabel } from "./shared";

/** /purchases/[id]: authorization preview, payment timeline and the evidence behind this purchase. */
export function PurchaseDetail() {
  const { id } = useParams<{ id: string }>();
  const purchase = useApiQuery(() => api.getPurchase(id), [id]);
  const missionId = purchase.data?.purchase.missionId;
  const mission = useApiQuery(() => (missionId ? api.getMission(missionId) : Promise.resolve(null)), [missionId]);
  const resources = useApiQuery(() => api.listResources(), []);
  const agents = useApiQuery(() => api.listAgents(), []);

  // Live updates: any activity for this purchase (authorization, OrderFunded, PaidOut…) refetches the stored state.
  const { reload } = purchase; // stable useCallback from useApiQuery
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.subscribe((m) => {
      if (m.type !== "activity" || m.event.purchaseId !== id) return;
      clearTimeout(timer);
      timer = setTimeout(reload, 300);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [id, reload]);

  if (purchase.error) return <ErrorState error={purchase.error} title="Could not read the purchase" />;
  if (purchase.loading || !purchase.data) return <SkeletonRows rows={6} />;

  const p = purchase.data.purchase;
  const resource = resources.data?.resources.find((r) => r.id === p.resourceId);
  const agentList = agents.data?.agents ?? [];
  const requests = mission.data?.requests ?? [];
  const groups = mission.data?.groups ?? [];
  const session = missionId ? recallProposal(missionId) : undefined;
  const evidence = session
    ? attachDecisions({ purchases: [p], groups, decisions: session.response.decisions, merges: session.response.merges }).byPurchase.get(p.id)
    : undefined;
  const group = groups.find((g) => g.id === p.purchaseGroupId);

  return (
    <>
      <PageHeader
        title={resource?.title ?? p.resourceId}
        description={`Purchase ${p.id} · mission ${p.missionId}`}
        actions={
          <>
            {resource?.simulated ? (
              <Simulated when what="seller">
                <span className="text-xs text-text-muted">{resource.sellerId}</span>
              </Simulated>
            ) : null}
            <StatusPill status={p.status} />
            <Link href={missionId ? `/purchases?missionId=${encodeURIComponent(missionId)}` : "/purchases"} className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text">
              <ArrowLeft className="size-3" aria-hidden /> all purchases
            </Link>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-6">
          <PurchaseAuthorization purchase={p} resource={resource} agents={agentList} payerEvidence={evidence?.outcome?.payer?.evidence} onAuthorized={() => purchase.reload()} />
          {evidence?.outcome ? (
            <FusionProposal outcome={evidence.outcome} requests={requests} agents={agentList} resources={resources.data?.resources ?? []} decisions={evidence.decisions} purchase={p} />
          ) : group ? (
            <StoredFusionSummary group={group} purchase={p} agents={agentList} />
          ) : null}
          {evidence?.decisions.map((d) => {
            const r = requests.find((x) => x.id === d.requestId);
            return <ResourceComparison key={d.requestId} decision={d} resources={resources.data?.resources ?? []} request={r} requester={r ? agentLabel(agentList, r.agentId) : undefined} />;
          })}
          {!evidence && p.oracleReason ? (
            <section className="rounded-xl border border-border bg-surface p-5">
              <h3 className="text-sm font-medium text-text">Oracle · stored reason</h3>
              <p className="mt-2 whitespace-pre-line text-xs text-text-muted">{p.oracleReason}</p>
            </section>
          ) : null}
        </div>
        <PaymentTimeline purchase={p} chainTransactions={purchase.data.chainTransactions} activity={purchase.data.activity} escrow={purchase.data.escrow} />
      </div>
    </>
  );
}
