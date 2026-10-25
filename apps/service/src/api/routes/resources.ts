import { IdSchema, ResourceRecordSchema } from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { parseQuery, respond, type ApiEnv } from "../http.js";
import { loadMission } from "./missions.js";

const Query = z.object({ missionId: IdSchema.optional() });
const Response = z.object({
  resources: z.array(ResourceRecordSchema),
  /** False until Oracle's coverage filter (P4.1) narrows the list per mission. */
  filtered: z.boolean(),
  missionId: IdSchema.optional(),
});

/** Candidate listings with their coverage. `simulated` passes through so the UI can label demo sellers. */
export function resourceRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();
  app.get("/", async (c) => {
    const { missionId } = parseQuery(c, Query);
    if (missionId) await loadMission(deps, c.get("session").organizationId, missionId);
    const resources = await deps.repos.resources.list();
    return respond(c, Response, { resources, filtered: false, ...(missionId ? { missionId } : {}) });
  });
  return app;
}
