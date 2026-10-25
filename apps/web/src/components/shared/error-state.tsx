import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

/** Shows the service's error envelope (code, message, requestId) or a plain error. Never a fake success. */
export function ErrorState({
  error,
  title = "Something failed",
  action,
  className,
}: {
  error: unknown;
  title?: string;
  action?: ReactNode;
  className?: string;
}) {
  const api = error instanceof ApiError ? error : null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className={cn("flex gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-4", className)}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium text-text">{title}</h2>
          {api ? (
            <span className="rounded-md bg-danger/10 px-1.5 font-mono text-[11px] text-danger">
              {api.status} {api.code}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-text-muted">{message}</p>
        {api?.requestId ? (
          <p className="mt-1 text-[11px] text-text-muted">
            request <span className="font-mono">{api.requestId}</span>
          </p>
        ) : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}
