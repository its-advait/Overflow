import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Labels simulated sellers, datasets, the attacker and the fictional company (CLAUDE.md rule). */
export function SimulatedBadge({ className, what }: { className?: string; what?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-md border border-violet/40 bg-violet/10 px-1.5 text-[10px] font-semibold tracking-wider text-violet",
        className,
      )}
      title={what ? `Simulated ${what}` : "Simulated for the demo"}
    >
      SIMULATED
    </span>
  );
}

/** Renders children and appends the badge when `when` is true. */
export function Simulated({ when, what, children }: { when: boolean | undefined; what?: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      {when ? <SimulatedBadge what={what} /> : null}
    </span>
  );
}
