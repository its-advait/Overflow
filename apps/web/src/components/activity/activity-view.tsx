"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ActivityEvent, PurchaseRecord } from "@overflow/schemas";
import { ErrorState } from "@/components/shared/error-state";
import { SkeletonRows } from "@/components/shared/skeleton";
import { Pill } from "@/components/shared/status-pill";
import { Button } from "@/components/ui/button";
import {
  ACTIVITY_PAGE,
  blockedEvents,
  isTypeGroup,
  matchesFilter,
  mergeLive,
  serverQueryFor,
  TYPE_GROUP_LABEL,
  TYPE_GROUP_ORDER,
  type ActivityFilter,
} from "@/lib/activity";
import { api } from "@/lib/api";
import { useApiQuery, useLastGood } from "@/lib/use-api";
import { ActivityFeed } from "./activity-feed";
import { BlockedLane } from "./blocked-lane";
import { EventDrawer } from "./event-drawer";

const SELECT = "h-9 min-w-48 rounded-lg border border-border bg-surface px-3 text-sm text-text";
/** Missions whose purchases are read for attribution (seller and amount of purchase-linked events). */
const MISSION_DETAILS = 20;
/** A safety re-read: the live stream merges frames as they arrive; this catches anything a reconnect missed. */
const REREAD_MS = 30_000;

type View = "feed" | "blocked";

/**
 * /activity: the audit view. One page from GET /api/activity (the service's single scope plus `kind`),
 * live frames from /events merged in by id, and the URL's mission / agent / type filter applied to both.
 * The Blocked lane is every refused payment; a row or card opens the event drawer.
 */
export function ActivityView() {
  const router = useRouter();
  const params = useSearchParams();
  const view: View = params.get("view") === "blocked" ? "blocked" : "feed";
  const type = params.get("type");
  const filter: ActivityFilter = useMemo(
    () => ({
      missionId: params.get("missionId") || undefined,
      agentId: params.get("agentId") || undefined,
      group: isTypeGroup(type) ? type : undefined,
    }),
    [params, type],
  );
  const query = serverQueryFor(filter, view === "blocked");
  const queryKey = JSON.stringify(query);

  const [tick, setTick] = useState(0);
  const page = useApiQuery(() => api.listActivity(query), [queryKey, tick]);
  const pageEvents = useLastGood(page.data?.events, queryKey);
  const missions = useApiQuery(() => api.listMissions(), []);
  const agents = useApiQuery(() => api.listAgents(), []);
  const resources = useApiQuery(() => api.listResources(), []);
  const missionIds = (missions.data?.missions ?? []).slice(0, MISSION_DETAILS).map((m) => m.id);
  const details = useApiQuery(
    () => Promise.all(missionIds.map((id) => api.getMission(id).then((r) => r.purchases).catch(() => [] as PurchaseRecord[]))),
    [missionIds.join(",")],
  );

  // Live: every activity frame the service streams, kept newest first and capped; filtered at render.
  const [live, setLive] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const unsubscribe = api.subscribe((m) => {
      setConnected(true);
      if (m.type === "activity") setLive((prev) => mergeLive(prev, [m.event]).slice(0, ACTIVITY_PAGE));
    });
    const reread = setInterval(() => setTick((t) => t + 1), REREAD_MS);
    return () => {
      unsubscribe();
      clearInterval(reread);
    };
  }, []);

  const [openId, setOpenId] = useState<string | null>(null);

  const setParam = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `/activity?${qs}` : "/activity", { scroll: false });
  };

  const liveMatching = live.filter((e) => matchesFilter(e, filter) && (view === "feed" || e.kind === "policy.blocked"));
  const events = pageEvents ? mergeLive(pageEvents.filter((e) => matchesFilter(e, filter)), liveMatching) : undefined;
  const lane = events ? blockedEvents(events) : undefined;
  const ctx = {
    agents: agents.data?.agents,
    resources: resources.data?.resources,
    purchases: details.data?.flat(),
  };
  const open = openId ? (events?.find((e) => e.id === openId) ?? live.find((e) => e.id === openId) ?? null) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Mission
            <select className={SELECT} value={filter.missionId ?? ""} onChange={(x) => setParam("missionId", x.target.value || undefined)} data-testid="filter-mission">
              <option value="">All missions</option>
              {(missions.data?.missions ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.goal.slice(0, 60)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Agent
            <select className={SELECT} value={filter.agentId ?? ""} onChange={(x) => setParam("agentId", x.target.value || undefined)} data-testid="filter-agent">
              <option value="">All agents</option>
              {(agents.data?.agents ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.department}
                </option>
              ))}
            </select>
          </label>
          {view === "feed" ? (
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              Type
              <select className={SELECT} value={filter.group ?? ""} onChange={(x) => setParam("type", x.target.value || undefined)} data-testid="filter-type">
                <option value="">All types</option>
                {TYPE_GROUP_ORDER.map((g) => (
                  <option key={g} value={g}>
                    {TYPE_GROUP_LABEL[g]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Pill tone={connected ? "success" : "muted"} title="Live frames from the service's /events stream">
            {connected ? "live" : "connecting"}
          </Pill>
          <div className="flex items-center gap-1" role="group" aria-label="View">
            <Button size="sm" variant={view === "feed" ? "default" : "outline"} aria-pressed={view === "feed"} onClick={() => setParam("view", undefined)} data-testid="view-feed">
              Feed{view === "feed" && events ? ` · ${events.length}` : ""}
            </Button>
            <Button size="sm" variant={view === "blocked" ? "default" : "outline"} aria-pressed={view === "blocked"} onClick={() => setParam("view", "blocked")} data-testid="view-blocked">
              Blocked{lane ? ` · ${lane.length}` : ""}
            </Button>
          </div>
        </div>
      </div>

      {page.error && !pageEvents ? (
        <ErrorState error={page.error} title="Could not read the activity" />
      ) : !events || !lane ? (
        <SkeletonRows rows={6} />
      ) : view === "blocked" ? (
        <BlockedLane events={lane} ctx={ctx} onOpen={(e) => setOpenId(e.id)} />
      ) : (
        <ActivityFeed events={events} ctx={ctx} onOpen={(e) => setOpenId(e.id)} />
      )}
      {page.error && pageEvents ? <p className="text-xs text-danger">The last re-read failed: {page.error.message}. Showing the previous page plus live frames.</p> : null}

      <EventDrawer event={open} ctx={ctx} missions={missions.data?.missions} onClose={() => setOpenId(null)} />
    </div>
  );
}
