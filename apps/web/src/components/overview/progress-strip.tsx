import type { MissionProgress } from "@/lib/overview";
import { cn } from "@/lib/utils";

/**
 * Discovered → Grouped → Authorized → Escrow → Settled. A cell lights up only
 * when a stored row reached that stage; the count is how many did. The three
 * money stages keep their colors (authorization blue, escrow cyan, settlement
 * success) so funding is never read as payment.
 */
export function ProgressStrip({ progress, className }: { progress: MissionProgress; className?: string }) {
  return (
    <ol className={cn("grid grid-cols-5 gap-1", className)} aria-label="Mission progress">
      {progress.stages.map((s) => (
        <li key={s.stage} className="flex min-w-0 flex-col gap-1" aria-current={progress.current === s.stage ? "step" : undefined}>
          <span className={cn("h-1.5 rounded-full", s.reached ? FILL[s.stage] : "bg-surface-raised")} />
          <span className={cn("flex items-baseline justify-between gap-1 text-[10px] leading-none", s.reached ? "text-text" : "text-text-muted")}>
            <span className="truncate">{s.stage}</span>
            <span className="tnum">{s.count}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

const FILL: Record<MissionProgress["stages"][number]["stage"], string> = {
  Discovered: "bg-violet",
  Grouped: "bg-violet",
  Authorized: "bg-blue",
  Escrow: "bg-cyan",
  Settled: "bg-success",
};
