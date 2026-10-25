"use client";

import { parseDecodedRevert, type ControllerRequest, type TreasuryNodeView } from "@overflow/schemas";
import { Address, TxHash } from "@/components/shared/address";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { SkeletonRows } from "@/components/shared/skeleton";
import { SimulatedBadge } from "@/components/shared/simulated-badge";
import { Pill } from "@/components/shared/status-pill";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { describeAction, PHASE_STYLE, phaseOf } from "@/lib/controller-phase";
import { nodeRequests, refusalsFor } from "@/lib/tree";
import { useApiQuery, useLastGood } from "@/lib/use-api";

const ACTIVITY_LIMIT = 300;

/**
 * Side panel for one node: its Paid logs, its refusals with the decoded reason, and the controller
 * requests about it with their phase and approval link. `version` bumps whenever the feed reported a
 * relevant event, so the lists refetch; nothing in here is derived from a local flag.
 */
export function AgentPanel({ node, version, onClose }: { node: TreasuryNodeView | null; version: number; onClose: () => void }) {
  const id = node?.id ?? null;
  const payments = useApiQuery(() => (id === null ? Promise.resolve(null) : api.listNodePayments(id)), [id, version]);
  const activity = useApiQuery(() => (id === null ? Promise.resolve(null) : api.listActivity({ limit: ACTIVITY_LIMIT })), [id, version]);
  const requests = useApiQuery(() => (id === null ? Promise.resolve(null) : api.listControllerRequests({ status: "all" })), [id, version]);
  // Keep the last good lists while a refetch is in flight so the panel does not flash on every event.
  const pay = useLastGood(payments.data ?? undefined, id);
  const act = useLastGood(activity.data ?? undefined, id);
  const req = useLastGood(requests.data ?? undefined, id);

  return (
    <Sheet open={node !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {node ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex flex-wrap items-center gap-2">
                <span>
                  node #{node.id} · {node.agent?.name ?? "unlabeled"}
                </span>
                {pay?.simulated ? <SimulatedBadge what="treasury" /> : null}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <span>{node.agent ? `${node.agent.role} · ${node.agent.department}` : "no agent record"}</span>
                <Address value={node.key} chars={6} />
              </SheetDescription>
            </SheetHeader>

            <Section title="Payments" hint="Paid(id, to, value) logs signed by this node, newest first. Each also charged every ancestor.">
              {payments.error ? (
                <ErrorState error={payments.error} title="Could not read payments" />
              ) : !pay ? (
                <SkeletonRows rows={3} />
              ) : pay.payments.length === 0 ? (
                <Empty text="No Paid log from this node yet." />
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {pay.payments.map((p) => (
                    <li key={`${p.txHash}:${p.logIndex}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                      <div className="flex flex-col gap-0.5">
                        <span className="flex items-center gap-1 text-text-muted">
                          to <Address value={p.to} chars={5} />
                        </span>
                        <span className="flex items-center gap-1 text-text-muted">
                          <TxHash value={p.txHash} chars={5} /> · block {p.blockNumber} · indexed {new Date(p.observedAt).toLocaleTimeString()}
                          {p.simulated ? <SimulatedBadge /> : null}
                        </span>
                      </div>
                      <Money atomic={p.value} size="sm" />
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Refusals" hint="policy.blocked events: this agent's rejected payments, plus any revert that names this node as the binding one.">
              {activity.error ? (
                <ErrorState error={activity.error} title="Could not read activity" />
              ) : !act ? (
                <SkeletonRows rows={2} />
              ) : (
                <Refusals node={node} events={act.events} />
              )}
            </Section>

            <Section title="Controller requests" hint="Owner calls proposed for this node. DONE appears only when the indexer stored the treasury event.">
              {requests.error ? (
                <ErrorState error={requests.error} title="Could not read controller requests" />
              ) : !req ? (
                <SkeletonRows rows={2} />
              ) : (
                <Requests requests={nodeRequests(req.requests, node.id)} />
              )}
            </Section>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 px-4 pb-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted" title={hint}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <EmptyState title={text} className="py-6" />;
}

function Refusals({ node, events }: { node: TreasuryNodeView; events: Parameters<typeof refusalsFor>[0] }) {
  const refusals = refusalsFor(events, node);
  if (refusals.length === 0) return <Empty text="No refusal recorded for this node." />;
  return (
    <ul className="flex flex-col divide-y divide-border">
      {refusals.map((e) => {
        const decoded = e.decodedRevert ? parseDecodedRevert(e.decodedRevert) : null;
        return (
          <li key={e.id} className="flex flex-col gap-1 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              {decoded ? (
                <Pill tone="danger" title={decoded.reason}>
                  {e.decodedRevert}
                </Pill>
              ) : (
                <Pill tone="danger">blocked</Pill>
              )}
              {decoded ? <span className="text-text">{decoded.reason}</span> : null}
              {e.simulated ? <SimulatedBadge /> : null}
            </div>
            <p className="text-text-muted break-words">{e.message}</p>
            <p className="flex flex-wrap items-center gap-2 text-text-muted">
              <span>{new Date(e.at).toLocaleString()}</span>
              {e.txHash ? <TxHash value={e.txHash} chars={5} /> : <span>no transaction (refused before broadcast)</span>}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function Requests({ requests }: { requests: ControllerRequest[] }) {
  if (requests.length === 0) return <Empty text="No controller request about this node." />;
  const rows = [...requests].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return (
    <ul className="flex flex-col divide-y divide-border">
      {rows.map((r) => {
        const phase = PHASE_STYLE[phaseOf(r)];
        const simulated = r.summary.includes("SIMULATED");
        return (
          <li key={r.id} className="flex flex-col gap-1 py-2 text-xs" data-request-id={r.id} data-phase={phaseOf(r)}>
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={phase.tone} title={phase.hint}>
                {phase.label}
              </Pill>
              <span className="font-medium text-text">{describeAction(r)}</span>
              {r.action.kind === "raise-cap" ? <Money atomic={r.action.newCapAtomic} size="sm" /> : null}
              {simulated ? <SimulatedBadge what="controller approval" /> : null}
            </div>
            <p className="font-mono text-text-muted break-words">{r.summary}</p>
            <p className="text-text-muted">
              {r.requestedBy}: {r.reason}
            </p>
            <p className="flex flex-wrap items-center gap-2 text-text-muted">
              <span>{new Date(r.createdAt).toLocaleString()}</span>
              {r.submission ? (
                <a className="text-blue underline underline-offset-4" href={r.submission.approvalUrl} target="_blank" rel="noreferrer noopener">
                  approval in Coinbase Wallet
                </a>
              ) : null}
              {r.txHash ? (
                <span className="flex items-center gap-1">
                  confirmed in <TxHash value={r.txHash} chars={5} />
                </span>
              ) : null}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
