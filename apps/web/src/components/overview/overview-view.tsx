"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { Plus } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { MissionDetailResponse } from "@/lib/api/contracts";
import { activeMissions, latestEvents, pickMission, spentForMission } from "@/lib/overview";
import { useApiQuery } from "@/lib/use-api";
import { LatestEvents } from "./latest-events";
import { MissionList } from "./mission-list";
import { MoneyCards } from "./money-cards";

const EVENT_LIMIT = 5;

/** The primary action. Composing happens on /missions; creating a mission buys nothing. */
export function CreateMissionAction() {
  return (
    <Link href="/missions" className={buttonVariants({ size: "lg" })}>
      <Plus data-icon="inline-start" aria-hidden />
      Create mission
    </Link>
  );
}

/**
 * Overview: what agents are doing (missions and events), how much they can
 * spend (treasury, reserved), what is being bought (escrow, spend) and whether
 * the money is safe (blocked events with their reason). Every number comes from
 * one API call and is shown only once that call returned; a live event refetches.
 */
export function OverviewView() {
  const treasury = useApiQuery(() => api.getTreasury(), []);
  const missions = useApiQuery(() => api.listMissions(), []);
  const ledger = useApiQuery(() => api.getLedger({ limit: 1 }), []);
  const activity = useApiQuery(() => api.listActivity({ limit: EVENT_LIMIT }), []);
  const agents = useApiQuery(() => api.listAgents(), []);

  const inFlight = useMemo(() => activeMissions(missions.data?.missions ?? []), [missions.data]);
  const focus = useMemo(() => pickMission(missions.data?.missions ?? []), [missions.data]);
  // One detail read per mission the page shows: the in-flight ones plus the Spent card's mission.
  const detailIds = useMemo(() => {
    const ids = inFlight.map((m) => m.id);
    if (focus && !ids.includes(focus.id)) ids.push(focus.id);
    return ids;
  }, [inFlight, focus]);
  const details = useApiQuery(
    () => Promise.all(detailIds.map((id) => api.getMission(id))).then((rows) => new Map<string, MissionDetailResponse>(rows.map((r) => [r.mission.id, r]))),
    [detailIds.join(",")],
  );

  // Live feed: any committed event may have moved a mission, a purchase, the books or the chain reading.
  const reloads = [treasury.reload, missions.reload, ledger.reload, activity.reload, details.reload];
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.subscribe((m) => {
      if (m.type !== "activity") return;
      clearTimeout(timer);
      timer = setTimeout(() => reloads.forEach((r) => r()), 400);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusDetail = focus ? details.data?.get(focus.id) : undefined;
  const spent = {
    loading: missions.loading || ledger.loading || (focus !== undefined && details.loading),
    error: missions.error ?? ledger.error ?? details.error,
    mission: focus,
    atomic: focus && focusDetail && ledger.data ? spentForMission(focusDetail.purchases.map((p) => p.id), ledger.data.allocations) : undefined,
  };

  return (
    <div className="flex flex-col gap-6">
      <MoneyCards treasury={treasury} spent={spent} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <MissionList missions={inFlight} details={details.data} loading={missions.loading} error={missions.error ?? details.error} createAction={<CreateMissionAction />} />
        <LatestEvents events={latestEvents(activity.data?.events ?? [], EVENT_LIMIT)} agents={agents.data?.agents} loading={activity.loading} error={activity.error} />
      </div>
    </div>
  );
}
