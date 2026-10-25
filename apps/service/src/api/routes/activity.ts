import { ActivityEventSchema, IdSchema } from "@overflow/schemas";
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
});
const Response = z.object({ events: z.array(ActivityEventSchema) });

export function activityRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();
  app.get("/", async (c) => {
    const { limit, purchaseId, missionId, agentId } = parseQuery(c, Query);
    const events = purchaseId
      ? (await deps.repos.activityEvents.listByPurchase(purchaseId)).slice(-limit)
      : missionId
        ? await deps.repos.activityEvents.listByMission(missionId, limit)
        : agentId
          ? await deps.repos.activityEvents.listByAgent(agentId, limit)
          : await deps.repos.activityEvents.listRecent(limit);
    return respond(c, Response, { events });
  });
  return app;
}
