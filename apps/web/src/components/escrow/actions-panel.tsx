import type { EscrowOrder, EscrowStatus } from "@overflow/schemas";
import { MoneyActionPreview } from "@/components/shared/money-action-preview";
import { Panel } from "@/components/shared/panel";
import { Pill } from "@/components/shared/status-pill";
import { ACTION_LABEL, ACTIONS_FROM, actionPreview, formatUnix, type MergedGates } from "@/lib/escrow/state";

/**
 * Only the calls the contract would accept right now appear as money-action previews (payer, amount, destination,
 * expected outcome). The others are listed with the revert the contract would raise. This page sends nothing: the
 * confirm button has no handler, and the footnote names who may send the call.
 */
export function ActionsPanel({
  escrow,
  status,
  gates,
  treasury,
  chainBalance,
  asOf,
}: {
  escrow: EscrowOrder;
  status: EscrowStatus;
  gates: MergedGates;
  treasury: string;
  chainBalance?: bigint | undefined;
  /** The clock the shown gates were judged at (unix seconds). */
  asOf: string;
}) {
  const candidates = ACTIONS_FROM[status];
  const allowed = candidates.filter((a) => gates[a].allowed);
  const refused = candidates.filter((a) => !gates[a].allowed);
  const decidedBy = gates[candidates[0] ?? "sweep"].decidedBy;
  return (
    <Panel
      title="Actions the contract would accept"
      aside={
        <Pill tone={decidedBy === "api" ? "success" : "muted"} title={decidedBy === "api" ? "gates judged by the service at the chain's block timestamp" : "gates judged by this page from the stored terms and the client clock"}>
          judged by {decidedBy === "api" ? "service (chain clock)" : "this page"} · {formatUnix(asOf)}
        </Pill>
      }
    >
      <div className="flex flex-col gap-4" data-testid="escrow-actions" data-allowed-count={allowed.length}>
        {allowed.length === 0 ? (
          <p className="text-sm text-text-muted" data-testid="no-actions">
            {status === "Settled" || status === "Refunded" ? "Terminal state. Nothing is left to do for this order." : "Nothing is callable right now; the gates below say when that changes."}
          </p>
        ) : null}
        {allowed.map((a) => {
          const g = gates[a];
          const p = actionPreview(a, escrow, treasury, chainBalance);
          return (
            <div key={a} data-testid="escrow-action" data-action={a} data-allowed="true">
              <MoneyActionPreview
                title={p.title}
                payer={p.payer}
                amountAtomic={p.amountAtomic}
                destination={p.destination}
                expectedOutcome={p.expectedOutcome}
                confirmLabel={`${ACTION_LABEL[a]} (sent by ${g.who})`}
                footnote={
                  <span className="flex flex-col gap-1">
                    <span>{g.reason}</span>
                    <span>
                      May be sent by: {g.who}. {g.decidedBy === "api" ? "Gate judged by the service." : "Gate judged by this page."}
                      {!g.localAgrees ? " This page's own check disagrees; reload." : ""} This page sends no transactions.
                    </span>
                  </span>
                }
              />
            </div>
          );
        })}
        {refused.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {refused.map((a) => {
              const g = gates[a];
              return (
                <li key={a} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs" data-testid="escrow-action" data-action={a} data-allowed="false">
                  <span className="font-medium text-text">{ACTION_LABEL[a]}</span>
                  <span className="max-w-xl text-right font-mono text-[11px] text-text-muted">
                    {g.reason}
                    {g.availableAt ? ` · available from ${formatUnix(g.availableAt)}` : ""}
                    {g.until ? ` · until ${formatUnix(g.until)}` : ""}
                    {!g.localAgrees ? " · this page disagrees" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}
