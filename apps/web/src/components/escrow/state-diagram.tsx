import type { EscrowStatus } from "@overflow/schemas";
import { TxHash } from "@/components/shared/address";
import { EscrowStatusPill } from "@/components/shared/status-pill";
import { HAPPY_PATH, refundReasonText, type Diagram, type DiagramNode, type NodeState } from "@/lib/escrow/state";
import { cn } from "@/lib/utils";

const MEANING: Record<EscrowStatus, string> = {
  Created: "Order deployed by the factory; nothing paid.",
  Funded: "Price (and the seller's bond) held by the escrow.",
  Revealed: "Seller published the key; challenge window open.",
  Settled: "Seller paid price + bond.",
  Refunded: "Whole balance back in the treasury.",
};

const NODE_CLASS: Record<NodeState, string> = {
  done: "border-success/40 bg-success/5",
  current: "border-current bg-surface-raised ring-2 ring-current/30",
  pending: "border-dashed border-border",
  unreachable: "border-dashed border-border opacity-40",
};

/** The colour the current node's ring and the taken edges take, per status (static classes so Tailwind keeps them). */
const STATUS_COLOR: Record<EscrowStatus, string> = {
  Created: "text-text-muted",
  Funded: "text-cyan",
  Revealed: "text-blue",
  Settled: "text-success",
  Refunded: "text-warning",
};

function Node({ node, current }: { node: DiagramNode; current: EscrowStatus }) {
  const lit = node.state === "current";
  return (
    <div
      data-testid="escrow-state-node"
      data-status={node.status}
      data-state={node.state}
      className={cn("flex min-h-24 flex-col gap-1.5 rounded-xl border p-3", NODE_CLASS[node.state], lit && STATUS_COLOR[current])}
      aria-current={lit ? "step" : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <EscrowStatusPill status={node.status} className={node.state === "pending" || node.state === "unreachable" ? "opacity-70" : undefined} />
        <span className="text-[10px] uppercase tracking-wider text-text-muted">{node.state === "current" ? "now" : node.state}</span>
      </div>
      <p className="text-xs text-text-muted">{MEANING[node.status]}</p>
      {node.evidence ? (
        <p className="mt-auto text-[11px] text-text-muted">
          <TxHash value={node.evidence.txHash} chars={4} /> · block {node.evidence.blockNumber}
        </p>
      ) : node.state === "done" || node.state === "current" ? (
        <p className="mt-auto text-[11px] text-text-muted">{node.status === "Created" ? "no OrderCreated log indexed" : "no log indexed yet"}</p>
      ) : null}
    </div>
  );
}

function Arrow({ taken, vertical = false, className }: { taken: boolean; vertical?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      data-taken={taken}
      className={cn("block rounded-full", vertical ? "mx-auto h-5 w-0.5" : "my-auto h-0.5 w-full", taken ? "bg-success/70" : "bg-border", className)}
    />
  );
}

/**
 * The contract's five states with the current one lit. Happy path across the top (Created → Funded → Revealed →
 * Settled), Refunded below with its three legal entries; every reached node shows the confirmed log that proves it.
 */
export function StateDiagram({ diagram }: { diagram: Diagram }) {
  const edge = (from: EscrowStatus, to: EscrowStatus): boolean => diagram.edges.find((e) => e.from === from && e.to === to)?.taken ?? false;
  const reason = refundReasonText(diagram.refundReason);
  return (
    <div data-testid="escrow-state-diagram" data-current={diagram.current} data-source={diagram.source} className="flex flex-col gap-2">
      <div className="grid grid-cols-[1fr_1.25rem_1fr_1.25rem_1fr_1.25rem_1fr] items-stretch gap-1">
        {HAPPY_PATH.map((s, i) => (
          <div key={s} className="contents">
            <Node node={diagram.nodes[s]} current={diagram.current} />
            {i < HAPPY_PATH.length - 1 ? (
              <div className="flex">
                <Arrow taken={edge(s, HAPPY_PATH[i + 1]!)} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-[1fr_1.25rem_1fr_1.25rem_1fr_1.25rem_1fr] gap-1">
        <Arrow vertical taken={edge("Created", "Refunded")} />
        <span />
        <Arrow vertical taken={edge("Funded", "Refunded")} />
        <span />
        <Arrow vertical taken={edge("Revealed", "Refunded")} />
        <span />
        <span />
      </div>
      <div className="grid grid-cols-[1fr_1.25rem_1fr_1.25rem_1fr_1.25rem_1fr] gap-1">
        <div className="col-span-5 flex flex-col gap-1">
          <Node node={diagram.nodes.Refunded} current={diagram.current} />
          {diagram.current === "Refunded" ? (
            <p className="text-xs text-text-muted" data-testid="refund-reason">
              <span className="font-medium text-text">Refunded(&quot;{diagram.refundReason ?? "?"}&quot;)</span>
              {diagram.refundOrigin ? ` from ${diagram.refundOrigin}. ` : " "}
              {reason}
            </p>
          ) : null}
        </div>
      </div>
      <ol className="sr-only">
        {(["Created", "Funded", "Revealed", "Settled", "Refunded"] as const).map((s) => (
          <li key={s}>
            {s}: {diagram.nodes[s].state}
          </li>
        ))}
      </ol>
    </div>
  );
}
