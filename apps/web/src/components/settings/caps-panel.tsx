"use client";

import { useState } from "react";
import type { ControllerRequest, TreasuryNodeView } from "@overflow/schemas";
import { RequestDialog } from "@/components/agents/request-dialog";
import type { RequestMode } from "@/components/agents/agent-menu";
import { Address } from "@/components/shared/address";
import { Money } from "@/components/shared/money";
import { Pill } from "@/components/shared/status-pill";
import { Button } from "@/components/ui/button";
import { describeAction, PHASE_STYLE, phaseOf } from "@/lib/controller-phase";
import { Panel, SELECT } from "@/components/missions/shared";

/**
 * Agent caps and payees: both are owner calls, so each control opens the same controller request dialog the
 * Agents page uses (POST /api/exceptions -> a pending ControllerRequest). The list below shows every request
 * with its phase; DONE appears only when the indexer stored the treasury event.
 */
export function CapsPanel({ nodes, requests, onChanged }: { nodes: readonly TreasuryNodeView[]; requests: readonly ControllerRequest[]; onChanged: () => void }) {
  const [nodeId, setNodeId] = useState(nodes[0]?.id ?? 0);
  const node = nodes.find((n) => n.id === nodeId) ?? nodes[0];
  const [target, setTarget] = useState<{ mode: RequestMode; node: TreasuryNodeView } | null>(null);
  const relevant = requests.filter((r) => r.action.kind === "raise-cap" || r.action.kind === "set-allow");
  return (
    <Panel title="Agent caps and payees">
      <p className="mb-3 text-xs text-text-muted">Raising a cap or allowing a new payee is the treasury owner&apos;s call: each control creates a controller request for the owner to approve in Coinbase Wallet. The new payee goes on the treasury&apos;s global allowlist.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Node
          <select className={SELECT} value={node?.id ?? ""} onChange={(e) => setNodeId(Number(e.target.value))} disabled={nodes.length === 0}>
            {nodes.length === 0 ? <option value="">no treasury nodes read</option> : null}
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                #{n.id} {n.agent ? `${n.agent.name} · ${n.agent.department}` : "unlabeled"} · {n.status}
              </option>
            ))}
          </select>
        </label>
        {node ? (
          <span className="text-xs text-text-muted">
            cap <Money atomic={node.cap} size="sm" /> · spent <Money atomic={node.spent} size="sm" /> · remaining <Money atomic={node.remaining} size="sm" /> · key <Address value={node.key} />
          </span>
        ) : null}
        <Button size="sm" variant="outline" disabled={!node} onClick={() => node && setTarget({ mode: "raise-cap", node })}>
          Raise cap
        </Button>
        <Button size="sm" variant="outline" disabled={!node} onClick={() => node && setTarget({ mode: "add-payee", node })}>
          Add payee
        </Button>
      </div>
      <h4 className="mt-4 text-xs font-medium uppercase tracking-wider text-text-muted">Cap and payee requests</h4>
      {relevant.length === 0 ? <p className="mt-2 text-xs text-text-muted">None yet.</p> : null}
      <ul className="mt-2 flex flex-col divide-y divide-border" data-testid="controller-requests">
        {relevant.map((r) => {
          const phase = PHASE_STYLE[phaseOf(r)];
          return (
            <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-xs" data-request-id={r.id} data-phase={phaseOf(r)}>
              <Pill tone={phase.tone} title={phase.hint}>
                {phase.label}
              </Pill>
              <span className="text-text">{describeAction(r)}</span>
              <span className="font-mono text-text-muted">{r.id}</span>
              {r.summary.includes("SIMULATED") ? <Pill tone="violet">SIMULATED</Pill> : null}
            </li>
          );
        })}
      </ul>
      <RequestDialog target={target} onClose={() => setTarget(null)} onSubmitted={onChanged} />
    </Panel>
  );
}
