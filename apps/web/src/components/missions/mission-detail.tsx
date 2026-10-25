"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, Play } from "lucide-react";
import type { ActivityEvent, PurchaseRecord } from "@overflow/schemas";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { SimulatedBadge } from "@/components/shared/simulated-badge";
import { SkeletonRows } from "@/components/shared/skeleton";
import { Pill, StatusPill } from "@/components/shared/status-pill";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import type { RunMissionResponse } from "@/lib/api/contracts";
import { agentProgress, outputs, recommendations, runState } from "@/lib/missions/progress";
import { canRun } from "@/lib/missions/status";
import { useApiQuery } from "@/lib/use-api";
import { RequirementsTable } from "./requirements-table";
import { Field, MissionStatusPill, Panel, agentLabel, formatWhen } from "./shared";

/**
 * /missions/[id]: the mission's stored state (GET /api/missions/:id) and the
 * activity the service wrote for it (GET /api/activity?missionId=). Progress,
 * recommendations and outputs are derived from those events; a run is shown
 * only as the service reported it.
 */
export function MissionDetail() {
  const { id } = useParams<{ id: string }>();
  const mission = useApiQuery(() => api.getMission(id), [id]);
  const activity = useApiQuery(() => api.listActivity({ missionId: id, limit: 500 }), [id]);
  const agents = useApiQuery(() => api.listAgents(), []);
  const resources = useApiQuery(() => api.listResources(), []);
  const [run, setRun] = useState<RunMissionResponse | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);

  const reloadMission = mission.reload;
  const reloadActivity = activity.reload;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.subscribe((m) => {
      if (m.type !== "activity" || m.event.missionId !== id) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        reloadMission();
        reloadActivity();
      }, 300);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [id, reloadMission, reloadActivity]);

  const reload = () => {
    reloadMission();
    reloadActivity();
  };

  const startRun = async () => {
    setRunning(true);
    setRunError(null);
    try {
      setRun(await api.runMission(id));
      reload();
    } catch (e) {
      setRunError(e);
    } finally {
      setRunning(false);
    }
  };

  if (mission.error) return <ErrorState error={mission.error} title="Could not read the mission" />;
  if (mission.loading || !mission.data) return <SkeletonRows rows={6} />;

  const m = mission.data.mission;
  const events = activity.data?.events ?? [];
  const agentList = agents.data?.agents ?? [];
  const progress = agentProgress(events);
  const recs = recommendations(events, mission.data.purchases, mission.data.groups);
  const outs = outputs(events);
  const state = runState(events);

  return (
    <>
      <PageHeader
        title={m.goal.length > 90 ? `${m.goal.slice(0, 90)}…` : m.goal}
        description={`Mission ${m.id} · created ${formatWhen(m.createdAt)}`}
        actions={
          <>
            <MissionStatusPill status={m.status} />
            <Link href="/missions" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text">
              <ArrowLeft className="size-3" aria-hidden /> all missions
            </Link>
          </>
        }
      />
      <div className="flex flex-col gap-6">
        <Panel
          title="Mission"
          aside={
            <>
              <Link href={`/purchases?missionId=${encodeURIComponent(m.id)}`} className="text-xs text-text-muted hover:text-text">
                purchases view
              </Link>
              <Button size="sm" onClick={startRun} disabled={running || !canRun(m)} title={canRun(m) ? "POST /api/missions/:id/run. Agents run under treasury policy; nothing is paid here." : "Run needs confirmed requirements."}>
                <Play data-icon="inline-start" />
                {running ? "Starting…" : "Run mission"}
              </Button>
            </>
          }
        >
          <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Field label="Budget">
              <Money atomic={m.budgetAtomic} size="md" />
            </Field>
            <Field label="Time horizon">{m.horizon ? `${m.horizon.start} → ${m.horizon.end}` : "none set"}</Field>
            <Field label="Allowed formats">{m.allowedFormats.join(", ")}</Field>
            <Field label="Owner">{m.ownerAgentId ? agentLabel(agentList, m.ownerAgentId) : "orchestrator"}</Field>
            <Field label="Paying node">node {m.rootNodeId}</Field>
            <Field label="Run">{state}</Field>
          </dl>
          {run ? (
            <p className="mt-3 text-xs text-text-muted">
              Service answered: <span className="font-mono">{run.runId}</span> · {run.note} · mission {run.mission.status}
            </p>
          ) : null}
          {runError ? <ErrorState error={runError} title="Run refused" className="mt-3" /> : null}
        </Panel>

        <RequirementsTable mission={m} requests={mission.data.requests} agents={agentList} onChanged={reload} />

        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title={`Agent progress · ${progress.length} agent(s) active`}>
            {activity.error ? (
              <ErrorState error={activity.error} title="Could not read the activity" />
            ) : progress.length === 0 ? (
              <p className="text-sm text-text-muted">No agent has acted on this mission yet. Progress is counted from stored events.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {progress.map((p) => (
                  <li key={p.agentId} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-text">{agentLabel(agentList, p.agentId)}</span>
                      <Pill tone="muted">{p.toolCalls} tool calls</Pill>
                      <Pill tone="muted">{p.toolResults} results</Pill>
                      {p.errors ? <Pill tone="warning">{p.errors} errors</Pill> : null}
                      {p.blocked ? <Pill tone="danger">{p.blocked} blocked by policy</Pill> : null}
                      {p.reports ? <Pill tone="success">{p.reports} report(s)</Pill> : null}
                    </div>
                    {p.lastMessage ? (
                      <p className="mt-1 truncate text-xs text-text-muted" title={p.lastMessage}>
                        {p.lastAt ? `${formatWhen(p.lastAt)} · ` : ""}
                        {p.lastMessage}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={`Recommendations · ${recs.length}`}>
            {recs.length === 0 ? (
              <p className="text-sm text-text-muted">No Oracle or Fusion decision stored for this mission. Decisions appear after a proposal; a recommendation authorizes no payment.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {recs.map((r, i) => (
                  <li key={`${r.at}-${i}`} className="rounded-lg border border-border p-3 text-xs">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <Pill tone={r.source === "oracle" ? "blue" : r.source === "fusion" ? "violet" : "muted"}>{r.source === "stored" ? "stored reason" : r.source}</Pill>
                      {r.simulated ? <SimulatedBadge /> : null}
                      <span className="text-text-muted">{formatWhen(r.at)}</span>
                      {r.purchaseId ? (
                        <Link href={`/purchases/${encodeURIComponent(r.purchaseId)}`} className="font-mono text-text-muted hover:text-cyan">
                          {r.purchaseId}
                        </Link>
                      ) : null}
                    </div>
                    <p className="text-text">{r.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <Panel title={`Purchases · ${mission.data.purchases.length}`}>
          {mission.data.purchases.length === 0 ? (
            <p className="text-sm text-text-muted">No purchase for this mission. Proposals come from the purchases view; each authorization is signed there.</p>
          ) : (
            <PurchasesTable purchases={mission.data.purchases} agentNames={(a) => agentLabel(agentList, a)} resourceTitle={(rid) => resources.data?.resources.find((r) => r.id === rid)?.title ?? rid} />
          )}
        </Panel>

        <Panel title={`Outputs · ${outs.length}`}>
          {outs.length === 0 ? (
            <p className="text-sm text-text-muted">No agent report yet. Outputs are the agents&apos; stored report_findings and the orchestrator&apos;s synthesis.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {outs.map((o, i) => (
                <li key={`${o.at}-${i}`} className="rounded-lg border border-border p-3">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                    <Pill tone={o.synthesis ? "cyan" : "muted"}>{o.synthesis ? "orchestrator synthesis" : "agent report"}</Pill>
                    <span>{agentLabel(agentList, o.agentId)}</span>
                    <span>{formatWhen(o.at)}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-text">{o.summary}</p>
                  {o.findings.length ? (
                    <ul className="mt-2 list-disc pl-5 text-xs text-text-muted">
                      {o.findings.map((f, j) => (
                        <li key={j}>{f}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={`Activity · ${events.length} event(s) for this mission`}>
          {activity.loading ? <SkeletonRows rows={4} /> : events.length === 0 ? <EmptyState title="No activity yet" description="Every step the service takes for this mission lands here." /> : <ActivityList events={events} agentNames={(a) => agentLabel(agentList, a)} />}
        </Panel>
      </div>
    </>
  );
}

function PurchasesTable({ purchases, agentNames, resourceTitle }: { purchases: readonly PurchaseRecord[]; agentNames: (id: string) => string; resourceTitle: (id: string) => string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
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
                  {resourceTitle(p.resourceId)}
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

function ActivityList({ events, agentNames }: { events: readonly ActivityEvent[]; agentNames: (id: string) => string }) {
  const newestFirst = [...events].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  return (
    <ul className="flex flex-col divide-y divide-border">
      {newestFirst.map((e) => (
        <li key={e.id} className="flex flex-wrap items-start gap-2 py-2 text-xs">
          <span className="w-32 shrink-0 text-text-muted tnum">{formatWhen(e.at)}</span>
          <Pill tone={e.kind === "policy.blocked" ? "danger" : e.kind.startsWith("escrow.") ? "cyan" : e.kind.startsWith("agent.") || e.kind === "mission.run" ? "violet" : "muted"}>{e.kind}</Pill>
          {e.simulated ? <SimulatedBadge /> : null}
          {e.agentId ? <span className="text-text-muted">{agentNames(e.agentId)}</span> : null}
          <span className="min-w-0 flex-1 break-words text-text">{e.message}</span>
          {e.decodedRevert ? <span className="font-mono text-danger">{e.decodedRevert}</span> : null}
          {e.purchaseId ? (
            <Link href={`/purchases/${encodeURIComponent(e.purchaseId)}`} className="font-mono text-text-muted hover:text-cyan">
              {e.purchaseId}
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
