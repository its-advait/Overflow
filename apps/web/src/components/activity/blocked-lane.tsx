"use client";

import type { ActivityEvent } from "@overflow/schemas";
import { ShieldCheck } from "lucide-react";
import { TxHash } from "@/components/shared/address";
import { CopyButton } from "@/components/shared/copy-button";
import { EmptyState } from "@/components/shared/empty-state";
import { formatWhen } from "@/components/shared/panel";
import { SimulatedBadge } from "@/components/shared/simulated-badge";
import { Pill } from "@/components/shared/status-pill";
import { countByFamily, describeEvent, refusalEvidence, type DescribeContext } from "@/lib/activity";
import { AmountCell, CounterpartyCell, openProps, StagePill } from "./parts";

/**
 * The Blocked lane: every refused payment, newest first, with the decoded revert, what it means, where it
 * was refused (simulation, onchain revert, USDC, before signing) and its evidence. Nothing here is a
 * success; each card is a policy.blocked row the service stored.
 */
export function BlockedLane({ events, ctx, onOpen }: { events: readonly ActivityEvent[]; ctx: DescribeContext; onOpen: (e: ActivityEvent) => void }) {
  if (events.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No refusals match"
        description="When the treasury, USDC or an agent's payment client refuses a payment, it lands here with the decoded reason and its evidence."
      />
    );
  }
  const families = countByFamily(events);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" data-testid="blocked-families">
        {families.map((f) => (
          <Pill key={f.family} tone="danger">
            {f.family} · {f.count}
          </Pill>
        ))}
      </div>
      <ul className="flex flex-col gap-2">
        {events.map((e) => {
          const r = refusalEvidence(e);
          const d = describeEvent(e, ctx);
          return (
            <li
              key={e.id}
              data-testid="blocked-row"
              data-id={e.id}
              data-decoded={r.decoded}
              data-family={r.family}
              data-stage={r.stage}
              className="flex cursor-pointer flex-col gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-xs hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-danger"
              {...openProps(e, onOpen)}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="danger" title={r.reason}>
                  <span className="font-mono">{r.decoded}</span>
                </Pill>
                <StagePill stage={r.stage} />
                {r.simulated ? <SimulatedBadge what={r.family === "USDC bypass" ? "attacker bypass" : "agent or seller"} /> : null}
                <span className="ml-auto text-text-muted tnum">{formatWhen(e.at)}</span>
              </div>
              <p className="text-sm text-danger">{r.reason}</p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-text-muted">
                <span>{d.agent ?? "no agent (sent outside the agents)"}</span>
                <span className="flex items-center gap-1">
                  <AmountCell atomic={d.amountAtomic} />
                  <span>to</span>
                  <CounterpartyCell value={d.counterparty} />
                </span>
                {r.bindingNode !== null ? <span>binding node #{r.bindingNode}</span> : null}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-text-muted" onClick={(x) => x.stopPropagation()}>
                {r.txHash ? (
                  <span className="flex items-center gap-1">
                    tx <TxHash value={r.txHash} chars={5} />
                  </span>
                ) : (
                  <span>no transaction (refused before broadcast)</span>
                )}
                {r.digest ? (
                  <span className="flex items-center gap-1">
                    digest
                    <span className="font-mono text-[12px] text-text" title={r.digest}>
                      {r.digest.slice(0, 10)}…{r.digest.slice(-6)}
                    </span>
                    <CopyButton value={r.digest} label="Copy authorization digest" />
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
