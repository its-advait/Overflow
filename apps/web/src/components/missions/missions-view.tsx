"use client";

import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { SkeletonRows } from "@/components/shared/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useApiQuery } from "@/lib/use-api";
import { MissionComposer } from "./mission-composer";
import { MissionStatusPill, formatWhen } from "./shared";

/** /missions: the stored missions (GET /api/missions) and the composer. */
export function MissionsView() {
  const missions = useApiQuery(() => api.listMissions(), []);
  return (
    <div className="flex flex-col gap-6">
      <MissionComposer />
      {missions.error ? (
        <ErrorState error={missions.error} title="Could not list missions" />
      ) : missions.loading || !missions.data ? (
        <SkeletonRows rows={3} />
      ) : missions.data.missions.length === 0 ? (
        <EmptyState title="No missions yet" description="Create one above. The Oracle then extracts requirements for you to review before anything is bought." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Goal</TableHead>
                <TableHead className="text-right">Budget</TableHead>
                <TableHead>Horizon</TableHead>
                <TableHead>Formats</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...missions.data.missions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <MissionStatusPill status={m.status} />
                  </TableCell>
                  <TableCell>
                    <Link href={`/missions/${encodeURIComponent(m.id)}`} className="text-sm text-text hover:text-cyan">
                      {m.goal.length > 100 ? `${m.goal.slice(0, 100)}…` : m.goal}
                    </Link>
                    <div className="font-mono text-[11px] text-text-muted">{m.id}</div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Money atomic={m.budgetAtomic} size="sm" />
                  </TableCell>
                  <TableCell className="text-xs text-text-muted tnum">{m.horizon ? `${m.horizon.start} → ${m.horizon.end}` : "—"}</TableCell>
                  <TableCell className="text-xs text-text-muted">{m.allowedFormats.join(", ")}</TableCell>
                  <TableCell className="text-xs text-text-muted">{formatWhen(m.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
