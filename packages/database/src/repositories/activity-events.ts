import { ActivityEventSchema, type ActivityEvent, type ActivityKind } from "@overflow/schemas";
import { and, asc, desc, eq, gt, gte, ne } from "drizzle-orm";
import type { Executor } from "../client";
import { withDbErrors } from "../errors";
import { activityEvents } from "../schema";
import { iso, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

export type ActivityEventInsert = WithOptional<ActivityEvent, "id" | "at" | "simulated">;

/** Optional narrowing every list applies on top of its own scope (the Blocked lane asks for `policy.blocked`). */
export interface ActivityListOptions {
  kind?: ActivityKind | undefined;
}

const scoped = (scope: ReturnType<typeof eq> | undefined, opts: ActivityListOptions) => {
  const byKind = opts.kind ? eq(activityEvents.kind, opts.kind) : undefined;
  return scope && byKind ? and(scope, byKind) : (scope ?? byKind);
};

const toRecord = (r: typeof activityEvents.$inferSelect): ActivityEvent =>
  parseOne(ActivityEventSchema, {
    id: r.id,
    at: iso(r.at),
    kind: r.kind,
    message: r.message,
    purchaseId: opt(r.purchaseId),
    missionId: opt(r.missionId),
    agentId: opt(r.agentId),
    decodedRevert: opt(r.decodedRevert),
    txHash: opt(r.txHash),
    simulated: r.simulated,
  });

export function activityEventsRepository(db: Executor) {
  return {
    async insert(input: ActivityEventInsert): Promise<ActivityEvent> {
      const row = ActivityEventSchema.parse({
        ...input,
        id: input.id ?? newId(),
        at: input.at ?? nowIso(),
      });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(activityEvents)
          .values({
            id: row.id,
            at: new Date(row.at),
            kind: row.kind,
            message: row.message,
            purchaseId: nul(row.purchaseId),
            missionId: nul(row.missionId),
            agentId: nul(row.agentId),
            decodedRevert: nul(row.decodedRevert),
            txHash: nul(row.txHash),
            simulated: row.simulated,
          })
          .returning(),
      );
      return toRecord(inserted!);
    },

    async getById(id: string): Promise<ActivityEvent | undefined> {
      const [r] = await db.select().from(activityEvents).where(eq(activityEvents.id, id));
      return r ? toRecord(r) : undefined;
    },

    /** Oldest first, one mission's events (orchestration runs are read back this way). */
    async listByMission(missionId: string, limit = 500, opts: ActivityListOptions = {}): Promise<ActivityEvent[]> {
      const rows = await db
        .select()
        .from(activityEvents)
        .where(scoped(eq(activityEvents.missionId, missionId), opts))
        .orderBy(asc(activityEvents.at), asc(activityEvents.id))
        .limit(limit);
      return rows.map(toRecord);
    },

    /** Newest first, one agent's events (the agent panel's refusals and requests). */
    async listByAgent(agentId: string, limit = 100, opts: ActivityListOptions = {}): Promise<ActivityEvent[]> {
      const rows = await db
        .select()
        .from(activityEvents)
        .where(scoped(eq(activityEvents.agentId, agentId), opts))
        .orderBy(desc(activityEvents.at), desc(activityEvents.id))
        .limit(limit);
      return rows.map(toRecord);
    },

    /** Newest first. */
    async listRecent(limit = 100, opts: ActivityListOptions = {}): Promise<ActivityEvent[]> {
      const rows = await db
        .select()
        .from(activityEvents)
        .where(scoped(undefined, opts))
        .orderBy(desc(activityEvents.at), desc(activityEvents.id))
        .limit(limit);
      return rows.map(toRecord);
    },

    /**
     * Events after `afterId` (SSE Last-Event-ID): everything with a later `at`,
     * plus events at the same instant other than `afterId` itself. Oldest first.
     * Unknown id: returns [] (the client then re-reads history).
     */
    async listAfter(afterId: string, limit = 500): Promise<ActivityEvent[]> {
      const anchor = await this.getById(afterId);
      if (!anchor) return [];
      const at = new Date(anchor.at);
      const rows = await db
        .select()
        .from(activityEvents)
        .where(and(gte(activityEvents.at, at), ne(activityEvents.id, afterId)))
        .orderBy(asc(activityEvents.at))
        .limit(limit);
      return rows.filter((r) => r.at.getTime() > at.getTime() || r.id !== afterId).map(toRecord);
    },

    /** Events strictly after an ISO instant, oldest first. */
    async listSince(sinceIso: string, limit = 500): Promise<ActivityEvent[]> {
      const rows = await db
        .select()
        .from(activityEvents)
        .where(gt(activityEvents.at, new Date(sinceIso)))
        .orderBy(asc(activityEvents.at))
        .limit(limit);
      return rows.map(toRecord);
    },

    async listByPurchase(purchaseId: string): Promise<ActivityEvent[]> {
      const rows = await db
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.purchaseId, purchaseId))
        .orderBy(activityEvents.at);
      return rows.map(toRecord);
    },
  };
}
