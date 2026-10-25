import type { ActivityEvent } from "@overflow/schemas";
import type { ActivityQuery } from "@/lib/api/contracts";
import { groupOf, type TypeGroup } from "./types";

/** What the /activity URL can narrow by. Every field is optional; unset means "all". */
export interface ActivityFilter {
  missionId?: string | undefined;
  agentId?: string | undefined;
  group?: TypeGroup | undefined;
}

/** The API caps a page at 500 events. */
export const ACTIVITY_PAGE = 500;

/** The same predicate the service applies, mirrored so live SSE frames obey the filter the page shows. */
export function matchesFilter(e: ActivityEvent, f: ActivityFilter): boolean {
  if (f.missionId && e.missionId !== f.missionId) return false;
  if (f.agentId && e.agentId !== f.agentId) return false;
  if (f.group && groupOf(e.kind) !== f.group) return false;
  return true;
}

export function filterActivity(events: readonly ActivityEvent[], f: ActivityFilter): ActivityEvent[] {
  return events.filter((e) => matchesFilter(e, f));
}

/**
 * The one query the service answers: it takes a single scope (mission wins over agent, as on the
 * service) plus an optional kind. The rest of the filter is applied in the browser on that page.
 * `blockedOnly` asks the service for policy.blocked rows so a busy feed cannot push refusals off the page.
 */
export function serverQueryFor(f: ActivityFilter, blockedOnly = false): ActivityQuery {
  const kind = blockedOnly || f.group === "blocked" ? "policy.blocked" : undefined;
  return {
    limit: ACTIVITY_PAGE,
    ...(f.missionId ? { missionId: f.missionId } : f.agentId ? { agentId: f.agentId } : {}),
    ...(kind ? { kind } : {}),
  };
}

/** Newest first by time, then id (times tie inside one batch). */
export function byNewest(a: ActivityEvent, b: ActivityEvent): number {
  return b.at.localeCompare(a.at) || b.id.localeCompare(a.id);
}

/** Merge live frames into a page: one row per id (the newer copy wins), newest first. */
export function mergeLive(events: readonly ActivityEvent[], incoming: readonly ActivityEvent[]): ActivityEvent[] {
  const byId = new Map<string, ActivityEvent>();
  for (const e of events) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort(byNewest);
}
