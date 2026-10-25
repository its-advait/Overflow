import { FlaskConical } from "lucide-react";
import { mocksEnabled } from "@/lib/api/client";
import { cn } from "@/lib/utils";

/**
 * Visible whenever the page is reading fixtures (NEXT_PUBLIC_USE_MOCKS=1).
 * `force` renders it regardless, for the component demo.
 */
export function MockBadge({ className, force = false }: { className?: string; force?: boolean }) {
  if (!force && !mocksEnabled()) return null;
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-1.5 text-[11px] font-semibold tracking-wide text-warning",
        className,
      )}
      title="Fixture data from apps/web/src/lib/mocks. Nothing here came from the chain or the service."
    >
      <FlaskConical className="size-3" aria-hidden />
      MOCK
    </span>
  );
}
