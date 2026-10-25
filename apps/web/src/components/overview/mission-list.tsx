"use client";

import Link from "next/link";
import { Target } from "lucide-react";
import type { MissionRecord } from "@overflow/schemas";
import { MissionStatusPill } from "@/components/missions/shared";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { Panel } from "@/components/shared/panel";
import { SkeletonRows } from "@/components/shared/skeleton";
import type { MissionDetailResponse } from "@/lib/api/contracts";
import { missionProgress } from "@/lib/overview";
import { ProgressStrip } from "./progress-strip";

/** Missions in flight with their status and progress strip, each strip derived from the mission's stored rows. */
export function MissionList({
  missions,
  details,
  loading,
  error,
  createAction,
}: {
  missions: readonly MissionRecord[];
  /** GET /api/missions/:id per listed mission; undefined while loading. */
  details: ReadonlyMap<string, MissionDetailResponse> | undefined;
  loading: boolean;
  error: Error | undefined;
  createAction: React.ReactNode;
}) {
  return (
    <Panel
      title="Active missions"
      aside={
        <Link href="/missions" className="text-xs text-text-muted hover:text-cyan">
          All missions
        </Link>
      }
    >
      {error ? (
        <ErrorState error={error} title="Could not list missions" />
      ) : loading ? (
        <SkeletonRows rows={3} />
      ) : missions.length === 0 ? (
        <EmptyState icon={Target} title="No mission in flight" description="Create one. The Oracle extracts requirements for you to review before anything is bought." action={createAction} />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {missions.map((m) => {
            const detail = details?.get(m.id);
            return (
              <li key={m.id} className="grid gap-3 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] lg:items-center">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <MissionStatusPill status={m.status} />
                    <Link href={`/missions/${encodeURIComponent(m.id)}`} className="min-w-0 truncate text-sm text-text hover:text-cyan" title={m.goal}>
                      {m.goal}
                    </Link>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
                    <span className="font-mono">{m.id}</span>
                    <span className="inline-flex items-baseline gap-1">
                      budget <Money atomic={m.budgetAtomic} size="sm" muted />
                    </span>
                    {detail ? <span>{detail.purchases.length} purchase(s)</span> : null}
                  </div>
                </div>
                {detail ? <ProgressStrip progress={missionProgress(detail)} /> : <SkeletonRows rows={1} className="w-full" />}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
