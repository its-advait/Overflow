"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { ErrorState } from "@/components/shared/error-state";
import { formatWhen } from "@/components/shared/panel";
import { SimulatedBadge } from "@/components/shared/simulated-badge";
import { SkeletonRows } from "@/components/shared/skeleton";
import { EscrowStatusPill, Pill, StatusPill } from "@/components/shared/status-pill";
import { PageHeader } from "@/components/shell/page-header";
import { api } from "@/lib/api";
import { challengeEndOf, currentStatus, deriveDiagram, gateActions, mergeGates } from "@/lib/escrow/state";
import { useApiQuery, useLastGood } from "@/lib/use-api";
import { useNowSeconds } from "@/lib/use-now";
import { ActionsPanel } from "./actions-panel";
import { EscrowPanel } from "./escrow-panel";
import { EvidencePanel } from "./evidence-panel";
import { SampleView } from "./sample-view";

const POLL_MS = 15_000;

/** /escrow/[id]: what happened to one order's money and why, from the stored terms, the chain read and the indexed logs. */
export function EscrowDetail() {
  const { id } = useParams<{ id: string }>();
  const query = useApiQuery(() => api.getEscrow(id), [id]);
  const data = useLastGood(query.data, id);
  const now = useNowSeconds();

  // Live updates: any activity for this purchase, a seller flag, or every 15 s (deadlines pass on the chain's clock).
  const { reload } = query;
  const purchaseId = data?.purchase.id;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.subscribe((m) => {
      if (m.type !== "activity") return;
      if (m.event.purchaseId !== purchaseId && m.event.kind !== "seller.flagged") return;
      clearTimeout(timer);
      timer = setTimeout(reload, 300);
    });
    const poll = setInterval(reload, POLL_MS);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      unsubscribe();
    };
  }, [purchaseId, reload]);

  if (query.error && !data) return <ErrorState error={query.error} title="Could not read the escrow" />;
  if (!data) return <SkeletonRows rows={8} />;

  const { escrow, purchase, resource, chain, chainTransactions, sample, complaint, actions, activity } = data;
  const { status, source } = currentStatus(escrow, chain);
  const diagram = deriveDiagram(escrow, chain, chainTransactions);
  const complaintReady = Boolean(complaint && complaint.cipherProofVerified && complaint.plainProofVerified && complaint.cheatVerified);
  const judgedAt = actions ? BigInt(actions.asOf) : BigInt(now);
  const local = gateActions({
    status,
    revealDeadline: BigInt(escrow.revealDeadline),
    challengeEnd: challengeEndOf(escrow, chain),
    balance: chain ? BigInt(chain.balanceAtomic) : 0n,
    now: judgedAt,
    complaintReady,
  });
  const gates = mergeGates(local, actions);

  return (
    <>
      <PageHeader
        title={resource?.title ?? purchase.resourceId}
        description={`Escrow ${escrow.escrowAddress} · purchase ${purchase.id}`}
        actions={
          <>
            {data.simulated ? <SimulatedBadge what="seller, dataset or judge" /> : null}
            <EscrowStatusPill status={status} />
            <StatusPill status={purchase.status} />
            {query.error ? (
              <Pill tone="warning" title={query.error.message}>
                showing last successful read
              </Pill>
            ) : null}
            <Link href={`/purchases/${encodeURIComponent(purchase.id)}`} className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text">
              purchase
            </Link>
            <Link href="/escrow" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text">
              <ArrowLeft className="size-3" aria-hidden /> all escrows
            </Link>
          </>
        }
      />
      <div className="flex flex-col gap-6" data-testid="escrow-detail" data-status={status} data-source={source} data-simulated={data.simulated}>
        <EscrowPanel escrow={escrow} chain={chain} chainUnavailable={data.chainUnavailable} chainTransactions={chainTransactions} nowSeconds={now} />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex flex-col gap-6">
            <SampleView sample={sample} escrow={escrow} />
            <EvidencePanel escrow={escrow} chain={chain} complaint={complaint} chainTransactions={chainTransactions} diagram={diagram} />
          </div>
          <div className="flex flex-col gap-6">
            <ActionsPanel escrow={escrow} status={status} gates={gates} treasury={purchase.buyerTreasury} chainBalance={chain ? BigInt(chain.balanceAtomic) : undefined} asOf={judgedAt.toString()} />
            <section className="rounded-xl border border-border bg-surface p-5">
              <h3 className="text-sm font-medium text-text">Activity for this order</h3>
              {activity.length === 0 ? (
                <p className="mt-2 text-xs text-text-muted">No activity recorded.</p>
              ) : (
                <ol className="mt-3 flex flex-col gap-2">
                  {[...activity]
                    .sort((a, b) => a.at.localeCompare(b.at))
                    .map((e) => (
                      <li key={e.id} className="text-xs">
                        <span className="text-text-muted">{formatWhen(e.at)}</span> <span className="font-mono text-[11px] text-text-muted">{e.kind}</span>
                        {e.simulated ? <span className="ml-1 text-[10px] text-violet">SIMULATED</span> : null}
                        <p className="text-text">{e.message}</p>
                      </li>
                    ))}
                </ol>
              )}
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
