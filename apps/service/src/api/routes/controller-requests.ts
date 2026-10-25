import { ControllerRequestSchema, ControllerRequestStatusSchema } from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { parseQuery, respond, type ApiEnv } from "../http.js";

const ListQuery = z.object({ status: ControllerRequestStatusSchema.or(z.literal("all")).optional() });
const ListResponse = z.object({
  requests: z.array(ControllerRequestSchema),
  /** The treasury every request targets; null when no deployment is configured. */
  treasury: z.string().nullable(),
});

/**
 * Prepared owner calls for Coinbase Wallet. Read-only: there is no route that
 * approves, sends or marks one done. "done" is written by the indexer alone.
 */
export function controllerRequestRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();
  app.get("/", async (c) => {
    const q = parseQuery(c, ListQuery);
    const requests = await deps.exceptions.listRequests(q.status ?? "pending");
    return respond(c, ListResponse, { requests, treasury: deps.exceptions.treasury });
  });
  return app;
}
