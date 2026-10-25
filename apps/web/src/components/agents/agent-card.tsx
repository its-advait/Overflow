"use client";

import { useEffect, useState } from "react";
import type { ControllerRequest, NodeStatus, TreasuryNodeView } from "@overflow/schemas";
import { Address } from "@/components/shared/address";
import { Money } from "@/components/shared/money";
import { Pill, type Tone } from "@/components/shared/status-pill";
import { Card, CardContent } from "@/components/ui/card";
import { PHASE_STYLE, phaseOf } from "@/lib/controller-phase";
import { expiryCountdown, nodeRequests } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { AgentMenu, type RequestMode } from "./agent-menu";
import { BudgetBar } from "./budget-bar";

const STATUS: Record<NodeStatus, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "success" },
  paused: { label: "Paused", tone: "muted" },
  expired: { label: "Expired", tone: "warning" },
};

/** Client clock for the expiry countdown; the card only exists after data arrived, so there is no SSR mismatch. */
function useNowSeconds(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * One treasury node. Every number is a view-call result from GET /api/treasury/nodes (or the
 * labelled simulation); the status is what settle() would see, so a node under a paused ancestor
 * reads Paused and the whole card greys out.
 */
export function AgentCard({
  node,
  requests,
  selected,
  onSelect,
  onAction,
}: {
  node: TreasuryNodeView;
  requests: readonly ControllerRequest[];
  selected: boolean;
  onSelect: () => void;
  onAction: (mode: RequestMode) => void;
}) {
  const now = useNowSeconds();
  const mine = nodeRequests(requests, node.id);
  const open = mine.filter((r) => r.status === "pending");
  const status = STATUS[node.status];
  const cause =
    node.status === "paused" && node.pausedBy !== null && node.pausedBy !== node.id
      ? `paused by ancestor node ${node.pausedBy}`
      : node.status === "expired" && node.expiredBy !== null && node.expiredBy !== node.id
        ? `expired through ancestor node ${node.expiredBy}`
        : node.status === "paused"
          ? "paused onchain (NodePaused)"
          : node.status === "expired"
            ? "authority expired onchain"
            : "settle() would accept a payment from this key";
  const name = node.agent?.name ?? `Unlabeled node #${node.id}`;
  const role = node.agent ? `${node.agent.role} · ${node.agent.department}` : "no agent record for this key";

  return (
    <Card
      size="sm"
      data-node-id={node.id}
      data-status={node.status}
      className={cn(
        "bg-surface transition-[opacity,filter,box-shadow] duration-300",
        selected && "ring-2 ring-blue/60",
        node.status === "paused" && "opacity-60 grayscale",
        node.status === "expired" && "opacity-75",
      )}
    >
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left" aria-pressed={selected} aria-label={`Open panel for ${name}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">node #{node.id}</span>
              <span className="text-sm font-medium text-text">{name}</span>
              <Pill tone={status.tone} title={cause}>
                {status.label}
              </Pill>
              {open.length > 0 ? (
                <Pill tone={PHASE_STYLE[phaseOf(open[0]!)].tone} title={`${open.length} open controller request(s)`}>
                  {open.length} {PHASE_STYLE[phaseOf(open[0]!)].label}
                </Pill>
              ) : null}
            </div>
            <div className="mt-0.5 text-xs text-text-muted">{role}</div>
          </button>
          <AgentMenu node={node} onAction={onAction} />
        </div>

        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span>key</span>
          <Address value={node.key} chars={6} />
        </div>

        <div className="flex flex-col gap-1.5">
          <BudgetBar spent={node.spent} cap={node.cap} remaining={node.remaining} status={node.status} />
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <Stat label="spent">
              <Money atomic={node.spent} size="sm" />
            </Stat>
            <Stat label="cap">
              <Money atomic={node.cap} size="sm" />
            </Stat>
            <Stat label="remaining()" hint="smallest cap − spent over this node and its ancestors">
              <Money atomic={node.remaining} size="sm" />
            </Stat>
            <Stat label="per call">
              <Money atomic={node.maxPerCall} size="sm" />
            </Stat>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-text-muted">
          <span title={`expiry ${node.expiry} (unix seconds)`}>
            expires in <span className="tnum text-text">{expiryCountdown(node.expiry, now)}</span>
          </span>
          <span>
            {node.payees.mode === "global" ? (
              <>
                payees: treasury allowlist (<span className="text-text">{node.payees.known.length}</span>)
              </>
            ) : (
              <>
                payees: <span className="text-text">{node.payees.known.length}</span> known for this node
                {node.payees.complete ? null : " · list may be incomplete"}
              </>
            )}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col" title={hint}>
      <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </div>
  );
}
