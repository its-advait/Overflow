"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import type { MissionRecord, PurchaseRecord } from "@overflow/schemas";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { SkeletonRows } from "@/components/shared/skeleton";
import { Pill, StatusPill } from "@/components/shared/status-pill";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import type { ProposeResponse } from "@/lib/api/contracts";
import { recallProposal, rememberProposal } from "@/lib/purchases/propose-cache";
import { useApiQuery } from "@/lib/use-api";
import { FusionProposal } from "./fusion-proposal";
import { ResourceComparison } from "./resource-comparison";
import { agentLabel, formatWhen } from "./shared";

/**
 * /purchases: pick a mission, see its stored purchases, run Oracle + Fusion
 * (POST /api/purchases/propose) and read every decision with its evidence.
 * The propose call is idempotent per request set on the service; it writes
 * activity events each run and never moves money.
 */
export function PurchasesView() {
  const router = useRouter();
  const params = useSearchParams();
  const missions = useApiQuery(() => api.listMissions(), []);
  const requested = params.get("missionId");
  const missionId = requested ?? pickDefault(missions.data?.missions);

  const mission = useApiQuery(() => (missionId ? api.getMission(missionId) : Promise.resolve(null)), [missionId]);
  const resources = useApiQuery(() => api.listResources(), []);
  const agents = useApiQuery(() => api.listAgents(), []);
  const [proposal, setProposal] = useState<{ at: string; response: ProposeResponse } | undefined>(() => (missionId ? recallProposal(missionId) : undefined));
  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState<unknown>(null);

  const propose = async () => {
    if (!missionId) return;
    setProposing(true);
    setProposeError(null);
    try {
      const response = await api.proposePurchases(missionId);
      rememberProposal(missionId, response);
      setProposal(recallProposal(missionId));
      mission.reload();
    } catch (e) {
      setProposeError(e);
    } finally {
      setProposing(false);
    }
  };

  if (missions.error) return <ErrorState error={missions.error} title="Could not list missions" />;
  if (missions.loading) return <SkeletonRows rows={3} />;
  if (!missionId || !missions.data?.missions.length) {
    return <EmptyState title="No missions yet" description="Create a mission and plan its requests; Oracle and Fusion proposals appear here." />;
  }
  const current = proposal && (!missionId || recallProposal(missionId) === proposal) ? proposal : missionId ? recallProposal(missionId) : undefined;
  const purchases = mission.data?.purchases ?? [];
  const requests = mission.data?.requests ?? [];
  const agentList = agents.data?.agents ?? [];
  const resourceList = resources.data?.resources ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Mission
          <select
            className="h-9 min-w-72 rounded-lg border border-border bg-surface px-3 text-sm text-text"
            value={missionId}
            onChange={(e) => {
              if (e.target.value !== requested) router.replace(`/purchases?missionId=${encodeURIComponent(e.target.value)}`);
            }}
          >
            {missions.data.missions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.goal.slice(0, 80)} · {m.status}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-3">
          {mission.data ? (
            <span className="text-xs text-text-muted">
              Budget <Money atomic={mission.data.mission.budgetAtomic} size="sm" /> · {requests.length} requests · {purchases.length} purchases
            </span>
          ) : null}
          <Button onClick={propose} disabled={proposing || !mission.data}>
            <Sparkles data-icon="inline-start" />
            {proposing ? "Running Oracle + Fusion…" : "Propose purchases"}
          </Button>
        </div>
      </div>
      {proposeError ? <ErrorState error={proposeError} title="Proposal refused" /> : null}

      {mission.error ? (
        <ErrorState error={mission.error} title="Could not read the mission" />
      ) : mission.loading ? (
        <SkeletonRows rows={4} />
      ) : purchases.length === 0 ? (
        <EmptyState title="No purchases for this mission" description="Run Oracle + Fusion to propose purchases. A proposal authorizes no payment." />
      ) : (
        <PurchasesTable purchases={purchases} agentNames={(id) => agentLabel(agentList, id)} />
      )}

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-text">Oracle and Fusion decisions</h2>
          {current ? (
            <Pill tone="blue">from this session&apos;s proposal run at {formatWhen(current.at)}</Pill>
          ) : (
            <span className="text-xs text-text-muted">
              Decisions are not stored by the service; run a proposal to see rule-by-rule evidence. Stored summaries show on each purchase.
            </span>
          )}
        </div>
        {current ? (
          <>
            {current.response.merges.map((m, i) => (
              <FusionProposal
                key={`${m.listingId ?? "none"}-${m.requestIds.join(",")}-${i}`}
                outcome={m}
                requests={requests}
                agents={agentList}
                resources={resourceList}
                decisions={current.response.decisions}
                purchase={m.merge && m.listingId ? [...current.response.purchases, ...purchases].find((p) => p.resourceId === m.listingId) : undefined}
              />
            ))}
            {current.response.decisions.map((d) => {
              const r = requests.find((x) => x.id === d.requestId);
              return <ResourceComparison key={d.requestId} decision={d} resources={resourceList} request={r} requester={r ? agentLabel(agentList, r.agentId) : undefined} />;
            })}
          </>
        ) : null}
      </section>
    </div>
  );
}

function pickDefault(missions: readonly MissionRecord[] | undefined): string | undefined {
  if (!missions?.length) return undefined;
  return (missions.find((m) => m.status === "active") ?? missions[0])?.id;
}

function PurchasesTable({ purchases, agentNames }: { purchases: readonly PurchaseRecord[]; agentNames: (id: string) => string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Resource</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Payer</TableHead>
            <TableHead>Agents</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {purchases.map((p) => (
            <TableRow key={p.id}>
              <TableCell>
                <StatusPill status={p.status} />
              </TableCell>
              <TableCell>
                <Link href={`/purchases/${encodeURIComponent(p.id)}`} className="text-sm text-text hover:text-cyan">
                  {p.resourceId}
                </Link>
                <div className="font-mono text-[11px] text-text-muted">{p.id}</div>
              </TableCell>
              <TableCell className="text-right">
                <Money atomic={p.amountAtomic} size="sm" />
              </TableCell>
              <TableCell className="text-xs text-text-muted">node {p.payingNodeId}</TableCell>
              <TableCell className="text-xs text-text-muted">
                {p.participatingAgentIds.map(agentNames).join(", ")}
                {p.purchaseGroupId ? (
                  <Pill tone="violet" className="ml-2">
                    merged
                  </Pill>
                ) : null}
              </TableCell>
              <TableCell className="text-xs text-text-muted">{formatWhen(p.updatedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
