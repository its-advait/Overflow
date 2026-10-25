import type { NodeStatus } from "@overflow/schemas";
import { barPercent } from "@/lib/tree";
import { cn } from "@/lib/utils";

/**
 * spent / cap as a bar. The fill is this node's own spend; the tick marks where an ancestor's
 * budget binds (cap - remaining) when that is tighter than the node's own spend, so a child
 * throttled by its parent is visible. Colours: paused / expired grey, >= 90 % warning, else success.
 */
export function BudgetBar({
  spent,
  cap,
  remaining,
  status,
  className,
}: {
  spent: string;
  cap: string;
  remaining: string;
  status: NodeStatus;
  className?: string;
}) {
  const pct = barPercent(spent, cap);
  const capBig = BigInt(cap);
  const bound = capBig - BigInt(remaining);
  const ancestorBinds = bound > BigInt(spent);
  const tickPct = ancestorBinds ? barPercent(bound, cap) : null;
  const fill = status !== "running" ? "bg-text-muted/60" : pct >= 90 ? "bg-warning" : "bg-success";
  return (
    <div
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-surface-raised", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={`${pct}% of cap spent`}
      title={`${pct}% of cap spent${tickPct !== null ? `; an ancestor's budget binds at ${tickPct}%` : ""}`}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500 ease-out", fill)} style={{ width: `${pct}%` }} />
      {tickPct !== null ? (
        <div
          className="absolute inset-y-0 w-0.5 bg-warning"
          style={{ left: `calc(${tickPct}% - 1px)` }}
          aria-hidden
          data-testid="ancestor-tick"
        />
      ) : null}
    </div>
  );
}
