import type { ActivityEvent, ChainTransaction, EscrowOrder, PurchaseRecord } from "@overflow/schemas";
import { TxHash } from "@/components/shared/address";
import { Pill, PURCHASE_STATUS_STYLE } from "@/components/shared/status-pill";
import { deriveTimeline, type TimelinePhase, type TimelineStep } from "@/lib/purchases/timeline";
import { cn } from "@/lib/utils";
import { formatWhen, Panel } from "./shared";

const PHASES: { phase: TimelinePhase; title: string }[] = [
  { phase: "authorization", title: "Authorization" },
  { phase: "funding", title: "Escrow funding" },
  { phase: "settlement", title: "Final settlement" },
];

const DOT: Record<TimelineStep["state"], string> = {
  done: "bg-current",
  current: "bg-current ring-4 ring-current/20",
  pending: "border border-border bg-transparent",
  skipped: "border border-dashed border-border bg-transparent",
};

/** PROPOSED through SETTLED or REFUNDED. Every tx link is a confirmed chain log or an event the service recorded with its hash. */
export function PaymentTimeline({
  purchase,
  chainTransactions,
  activity,
  escrow,
}: {
  purchase: PurchaseRecord;
  chainTransactions: readonly ChainTransaction[];
  activity: readonly ActivityEvent[];
  escrow?: EscrowOrder | null | undefined;
}) {
  const steps = deriveTimeline({ purchase, chainTransactions, activity, escrow: escrow ?? null });
  return (
    <Panel title="Payment timeline" aside={<span className="text-xs text-text-muted">status from the service; funding and settlement only from chain events</span>}>
      <ol className="flex flex-col gap-5">
        {PHASES.map(({ phase, title }) => {
          const own = steps.filter((s) => s.phase === phase);
          if (own.length === 0) return null;
          return (
            <li key={phase}>
              <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">{title}</h4>
              <ol className="flex flex-col gap-3 border-l border-border pl-4">
                {own.map((step) => (
                  <Step key={step.status} step={step} />
                ))}
              </ol>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

function Step({ step }: { step: TimelineStep }) {
  const style = PURCHASE_STATUS_STYLE[step.status];
  const muted = step.state === "pending" || step.state === "skipped";
  return (
    <li className={cn("relative", muted && "opacity-60")}>
      <span className={cn("absolute -left-[21px] top-1.5 size-2.5 rounded-full", `text-${style.tone === "muted" ? "text-muted" : style.tone}`, DOT[step.state])} aria-hidden />
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={muted ? "muted" : style.tone} title={style.hint}>
          {style.label}
        </Pill>
        <span className="text-xs text-text-muted">{step.state}</span>
        {step.at ? <span className="text-xs text-text-muted">{formatWhen(step.at)}</span> : null}
        {step.source !== "none" ? <span className="text-[10px] uppercase tracking-wider text-text-muted">{step.source === "chain" ? "chain event" : "service record"}</span> : null}
      </div>
      {step.txHash ? (
        <div className="mt-1 text-xs text-text-muted">
          <TxHash value={step.txHash} />
          {step.blockNumber ? ` · block ${step.blockNumber}` : ""}
        </div>
      ) : null}
      {step.decodedRevert ? <div className="mt-1 font-mono text-xs text-danger">{step.decodedRevert}</div> : null}
      {step.note && !step.decodedRevert ? <div className="mt-1 text-xs text-text-muted">{step.note}</div> : null}
    </li>
  );
}
