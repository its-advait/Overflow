import { Clapperboard } from "lucide-react";
import { cn } from "@/lib/utils";

/** Marks a demo run that replays a scripted beat (docs/SPEC.md "Demo"). Only rendered when the shell says so. */
export function ScriptedBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md border border-violet/40 bg-violet/10 px-1.5 text-[11px] font-semibold tracking-wide text-violet",
        className,
      )}
      title="This run replays a scripted beat. Everything else on screen is live."
    >
      <Clapperboard className="size-3" aria-hidden />
      SCRIPTED
    </span>
  );
}
