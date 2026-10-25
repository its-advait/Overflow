import { Clapperboard } from "lucide-react";
import { cn } from "@/lib/utils";

/** Marks a run whose model answers replay from a recording (docs/SPEC.md "Scripted replay"). Rendered by ScriptedStatus from GET /. */
export function ScriptedBadge({ className, title }: { className?: string; title?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md border border-violet/40 bg-violet/10 px-1.5 text-[11px] font-semibold tracking-wide text-violet",
        className,
      )}
      title={title ?? "Model answers replay from a recording. Everything else on screen is live."}
    >
      <Clapperboard className="size-3" aria-hidden />
      SCRIPTED
    </span>
  );
}
