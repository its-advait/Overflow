import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export { Skeleton };

/** Loading placeholder for a list or table body. */
export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Loading placeholder for a stat card: a quiet label and a large number. */
export function SkeletonStat({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-busy="true">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-8 w-36" />
    </div>
  );
}
