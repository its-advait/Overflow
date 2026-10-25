import { ActivityEventSchema, ActivityKindSchema, IdSchema } from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { parseQuery, respond, type ApiEnv } from "../http.js";

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  purchaseId: IdSchema.optional(),
  missionId: IdSchema.optional(),
  /** One agent's events (policy.blocked refusals, controller requests, tool calls), newest first. */
  agentId: IdSchema.optional(),
  /** Narrow any of the above (or the recent list) to one kind; the Blocked lane asks for policy.blocked. */
  kind: ActivityKindSchema.optional(),
});
const Response = z.object({ events: z.array(ActivityEventSchema) });

export function activityRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();
  app.get("/", async (c) => {
    const { limit, purchaseId, missionId, agentId, kind } = parseQuery(c, Query);
    const opts = kind ? { kind } : {};
    const events = purchaseId
      ? (await deps.repos.activityEvents.listByPurchase(purchaseId)).filter((e) => !kind || e.kind === kind).slice(-limit)
      : missionId
        ? await deps.repos.activityEvents.listByMission(missionId, limit, opts)
        : agentId
          ? await deps.repos.activityEvents.listByAgent(agentId, limit, opts)
          : await deps.repos.activityEvents.listRecent(limit, opts);
    return respond(c, Response, { events });
  });
  return app;
}
