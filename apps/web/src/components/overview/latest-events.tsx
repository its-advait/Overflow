"use client";

import Link from "next/link";
import { Activity } from "lucide-react";
import type { ActivityEvent, AgentRecord } from "@overflow/schemas";
import { agentLabel } from "@/components/purchases/shared";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { formatWhen, Panel } from "@/components/shared/panel";
import { SimulatedBadge } from "@/components/shared/simulated-badge";
import { SkeletonRows } from "@/components/shared/skeleton";
import { Pill } from "@/components/shared/status-pill";
import { blockedReason, eventTone, isBlocked } from "@/lib/overview";
import { cn } from "@/lib/utils";

/** The newest events from GET /api/activity, as the service wrote them. Blocked ones take the danger color and show their reason. */
export function LatestEvents({
  events,
  agents,
  loading,
  error,
}: {
  events: readonly ActivityEvent[];
  agents: readonly AgentRecord[] | undefined;
  loading: boolean;
  error: Error | undefined;
}) {
  return (
    <Panel
      title="Latest events"
      aside={
        <Link href="/activity" className="text-xs text-text-muted hover:text-cyan">
          Full activity
        </Link>
      }
    >
      {error ? (
        <ErrorState error={error} title="Could not read the activity" />
      ) : loading ? (
        <SkeletonRows rows={5} />
      ) : events.length === 0 ? (
        <EmptyState icon={Activity} title="No events yet" description="Every step the service takes lands here: proposals, authorizations, escrow events, refusals." />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {events.map((e) => {
            const blocked = isBlocked(e);
            const reason = blockedReason(e);
            return (
              <li key={e.id} className={cn("flex flex-col gap-1 py-2 text-xs", blocked && "-mx-2 rounded-lg bg-danger/5 px-2")}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-text-muted tnum">{formatWhen(e.at)}</span>
                  <Pill tone={eventTone(e.kind)}>{blocked ? "blocked" : e.kind}</Pill>
                  {e.simulated ? <SimulatedBadge /> : null}
                  {e.agentId ? <span className="text-text-muted">{agentLabel(agents, e.agentId)}</span> : null}
                  {e.purchaseId ? (
                    <Link href={`/purchases/${encodeURIComponent(e.purchaseId)}`} className="font-mono text-text-muted hover:text-cyan">
                      {e.purchaseId}
                    </Link>
                  ) : null}
                </div>
                <p className={cn("break-words", blocked ? "text-danger" : "text-text")}>{e.message}</p>
                {blocked && reason && reason !== e.message ? (
                  <p className="text-danger">
                    reason <span className="font-mono">{reason}</span>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
