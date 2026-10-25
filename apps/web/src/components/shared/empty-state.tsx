import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface/40 px-6 py-14 text-center",
        className,
      )}
    >
      <span className="mb-3 grid size-10 place-items-center rounded-full bg-surface-raised text-text-muted">
        <Icon className="size-5" aria-hidden />
      </span>
      <h2 className="text-sm font-medium text-text">{title}</h2>
      {description ? <p className="mt-1 max-w-sm text-sm text-text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
