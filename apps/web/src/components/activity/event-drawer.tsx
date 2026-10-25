"use client";

import Link from "next/link";
import type { ActivityEvent, ChainTransaction, MissionRecord, ResourceRecord } from "@overflow/schemas";
import { Address, Mono, TxHash } from "@/components/shared/address";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { SimulatedBadge } from "@/components/shared/simulated-badge";
import { SkeletonRows } from "@/components/shared/skeleton";
import { EscrowStatusPill, Pill, StatusPill } from "@/components/shared/status-pill";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { describeEvent, parseModelCall, parseSourceRefs, refusalEvidence, type DescribeContext } from "@/lib/activity";
import { api } from "@/lib/api";
import { eventTone, isBlocked } from "@/lib/overview/events";
import { useApiQuery } from "@/lib/use-api";
import { stageHint, StagePill } from "./parts";

/**
 * One event in full: who, what, the decoded refusal, its source reference (transaction and the matching
 * indexed logs with their log index, the authorization digest, the model-call hashes, the service's
 * `[kind:reference]` tokens) and the related purchase as GET /api/purchases/:id returns it.
 */
export function EventDrawer({
  event,
  ctx,
  missions,
  onClose,
}: {
  event: ActivityEvent | null;
  ctx: DescribeContext;
  missions: readonly MissionRecord[] | undefined;
  onClose: () => void;
}) {
  return (
    <Sheet open={event !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-testid="event-drawer">
        {event ? <Body event={event} ctx={ctx} missions={missions} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function Body({ event: e, ctx, missions }: { event: ActivityEvent; ctx: DescribeContext; missions: readonly MissionRecord[] | undefined }) {
  const d = describeEvent(e, ctx);
  const parsed = parseSourceRefs(e.message);
  const blocked = isBlocked(e);
  const refusal = blocked ? refusalEvidence(e) : null;
  const call = parseModelCall(e);
  const mission = e.missionId ? missions?.find((m) => m.id === e.missionId) : undefined;
  const purchase = useApiQuery(() => (e.purchaseId ? api.getPurchase(e.purchaseId) : Promise.resolve(null)), [e.purchaseId ?? null]);
  const logs: ChainTransaction[] = e.txHash && purchase.data ? purchase.data.chainTransactions.filter((t) => t.txHash.toLowerCase() === e.txHash!.toLowerCase()) : [];
  const resource: ResourceRecord | undefined = purchase.data ? ctx.resources?.find((r) => r.id === purchase.data!.purchase.resourceId) : undefined;
  const otherRefs = parsed.refs.filter((r) => !(r.kind === "facilitator" && r.reference === refusal?.digest));

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex flex-wrap items-center gap-2">
          <Pill tone={eventTone(e.kind)}>{e.kind}</Pill>
          {e.simulated ? <SimulatedBadge /> : null}
        </SheetTitle>
        <SheetDescription className="font-mono text-xs tnum">{e.at}</SheetDescription>
      </SheetHeader>

      <Section title="What happened">
        <Row label="Agent">{d.agent ? <Link href="/agents" className="hover:text-cyan">{d.agent}</Link> : <span className="text-text-muted">no agent (system, chain or a caller outside the agents)</span>}</Row>
        <Row label="Mission">
          {e.missionId ? (
            <Link href={`/missions/${encodeURIComponent(e.missionId)}`} className="hover:text-cyan">
              {mission ? mission.goal.slice(0, 90) : e.missionId}
            </Link>
          ) : (
            <span className="text-text-muted">none</span>
          )}
        </Row>
        {d.amountAtomic ? (
          <Row label="Amount">
            <Money atomic={d.amountAtomic} size="sm" />
          </Row>
        ) : null}
        {d.counterparty ? (
          <Row label="Counterparty">
            {d.counterparty.kind === "url" ? <span className="font-mono text-[12px] break-all">{d.counterparty.value}</span> : <Address value={d.counterparty.value} chars={6} />}
          </Row>
        ) : null}
        <p className="rounded-lg border border-border bg-surface px-3 py-2 text-xs break-words whitespace-pre-wrap text-text" data-testid="drawer-message">
          {e.message}
        </p>
      </Section>

      {refusal ? (
        <Section title="Refusal">
          <Row label="Decoded">
            <span className="font-mono text-danger" data-testid="drawer-decoded">
              {refusal.decoded}
            </span>
          </Row>
          <Row label="Means">
            <span className="text-danger">{refusal.reason}</span>
          </Row>
          <Row label="Where">
            <span className="flex flex-col gap-1">
              <StagePill stage={refusal.stage} />
              <span className="text-text-muted">{stageHint(refusal.stage)}</span>
            </span>
          </Row>
          <Row label="Family">{refusal.family}</Row>
          {refusal.bindingNode !== null ? <Row label="Binding node">#{refusal.bindingNode}</Row> : null}
        </Section>
      ) : null}

      <Section title="Source reference">
        <Row label="Transaction">
          {e.txHash ? <TxHash value={e.txHash} chars={8} /> : <span className="text-text-muted">{blocked ? "none: refused before broadcast" : "none recorded"}</span>}
        </Row>
        {e.txHash ? (
          <Row label="Log index">
            {blocked ? (
              <span className="text-text-muted" data-testid="drawer-logs">
                no log: a reverted transaction emits none
              </span>
            ) : !e.purchaseId ? (
              <span className="text-text-muted" data-testid="drawer-logs">
                not linked to a purchase; the indexer stores logs per order
              </span>
            ) : purchase.error ? (
              <span className="text-danger">could not read the logs for this purchase</span>
            ) : purchase.loading ? (
              <SkeletonRows rows={1} />
            ) : logs.length === 0 ? (
              <span className="text-text-muted" data-testid="drawer-logs">
                no indexed log for this transaction yet
              </span>
            ) : (
              <ul className="flex flex-col gap-0.5" data-testid="drawer-logs">
                {logs.map((l) => (
                  <li key={l.id} className="font-mono text-[12px]">
                    {l.eventName} · log {l.logIndex} · block {l.blockNumber}
                    {l.confirmed ? "" : " · unconfirmed"}
                  </li>
                ))}
              </ul>
            )}
          </Row>
        ) : null}
        {refusal?.digest ? (
          <Row label="Authorization digest">
            <Mono value={refusal.digest} className="text-[12px]" />
          </Row>
        ) : null}
        {call ? (
          <>
            <Row label="Model call">
              {call.model} · attempt {call.attempt} · {call.outcome}
            </Row>
            <Row label="Prompt hash">
              <Mono value={call.promptHash} className="text-[12px]" />
            </Row>
            <Row label="Output hash">
              <Mono value={call.outputHash} className="text-[12px]" />
            </Row>
          </>
        ) : null}
        {otherRefs.map((r) => (
          <Row key={`${r.kind}:${r.reference}`} label={r.kind}>
            <Mono value={r.reference} className="text-[12px]" />
          </Row>
        ))}
        {parsed.flags.length > 0 ? <Row label="Flags">{parsed.flags.join(", ")}</Row> : null}
        <Row label="Event id">
          <Mono value={e.id} className="text-[12px]" />
        </Row>
      </Section>

      <Section title="Related purchase">
        {!e.purchaseId ? (
          <p className="text-xs text-text-muted">This event is not tied to an order.</p>
        ) : purchase.error ? (
          <ErrorState error={purchase.error} title="Could not read the purchase" />
        ) : !purchase.data ? (
          <SkeletonRows rows={3} />
        ) : (
          <div className="flex flex-col gap-2 text-xs" data-testid="drawer-purchase">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={purchase.data.purchase.status} />
              {purchase.data.escrow ? <EscrowStatusPill status={purchase.data.escrow.status} /> : null}
              <Money atomic={purchase.data.purchase.amountAtomic} size="sm" />
            </div>
            <Row label="Resource">{resource?.title ?? purchase.data.purchase.resourceId}</Row>
            <Row label="Seller">
              <Address value={purchase.data.purchase.sellerAddress} chars={6} />
            </Row>
            <Row label="Paying node">#{purchase.data.purchase.payingNodeId}</Row>
            <div className="flex flex-wrap gap-3">
              <Link href={`/purchases/${encodeURIComponent(e.purchaseId)}`} className="text-cyan hover:underline">
                Open purchase
              </Link>
              {purchase.data.escrow ? (
                <Link href={`/escrow/${encodeURIComponent(e.purchaseId)}`} className="text-cyan hover:underline">
                  Open escrow
                </Link>
              ) : null}
            </div>
          </div>
        )}
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 px-4 pb-4">
      <h3 className="text-xs font-medium tracking-wider text-text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-start gap-2 text-xs">
      <span className="text-text-muted">{label}</span>
      <span className="min-w-0 text-text">{children}</span>
    </div>
  );
}
