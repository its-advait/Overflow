import { IdSchema, ResourceRecordSchema, UpdateResourceBodySchema } from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { ApiError, parseBody, parseParams, parseQuery, respond, type ApiEnv } from "../http.js";
import { loadMission } from "./missions.js";

const Query = z.object({ missionId: IdSchema.optional() });
const Response = z.object({
  resources: z.array(ResourceRecordSchema),
  /** False until Oracle's coverage filter (P4.1) narrows the list per mission. */
  filtered: z.boolean(),
  missionId: IdSchema.optional(),
});
const IdParams = z.object({ id: IdSchema });
const UpdateResponse = z.object({ resource: ResourceRecordSchema });

/** Candidate listings with their coverage. `simulated` passes through so the UI can label demo sellers. */
export function resourceRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();
  app.get("/", async (c) => {
    const { missionId } = parseQuery(c, Query);
    if (missionId) await loadMission(deps, c.get("session").organizationId, missionId);
    const resources = await deps.repos.resources.list();
    return respond(c, Response, { resources, filtered: false, ...(missionId ? { missionId } : {}) });
  });

  /**
   * Judge control (docs/SPEC.md "A judge's own scenario"): price, license flag or seats of a SIMULATED listing.
   * The next Oracle/Fusion run and the next recourse order read the row. Real sellers' listings are refused.
   */
  app.put("/:id", async (c) => {
    const { id } = parseParams(c, IdParams);
    const body = await parseBody(c, UpdateResourceBodySchema);
    const current = await deps.repos.resources.getById(id);
    if (!current) throw new ApiError(404, "not_found", `resource ${id} not found`, { table: "resources", id });
    if (!current.simulated) throw new ApiError(409, "not_simulated", `resource ${id} is not a SIMULATED listing; judge controls only edit simulated sellers' listings`, { id });
    const resource = await deps.repos.resources.update(id, body);
    return respond(c, UpdateResponse, { resource: resource! });
  });
  return app;
}
