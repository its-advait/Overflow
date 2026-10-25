import { NotFoundError } from "@overflow/database";
import { ControllerRequestSchema, ControllerRequestStatusSchema, IdSchema } from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import { SubmitControllerRequestInputSchema } from "../../exceptions/service.js";
import type { ApiDeps } from "../deps.js";
import { parseBody, parseParams, parseQuery, respond, type ApiEnv } from "../http.js";

const ListQuery = z.object({ status: ControllerRequestStatusSchema.or(z.literal("all")).optional() });
const ListResponse = z.object({
  requests: z.array(ControllerRequestSchema),
  /** The treasury every request targets; null when no deployment is configured. */
  treasury: z.string().nullable(),
});
const IdParams = z.object({ id: IdSchema });
const SubmissionResponse = z.object({
  request: ControllerRequestSchema,
  /** False when the same Wallet MCP request id was already on file. */
  recorded: z.boolean(),
});

/**
 * Prepared owner calls for Coinbase Wallet. Nothing here approves, sends or
 * marks one done: "done" is written by the indexer alone. The controller
 * (a Claude session with Wallet MCP) reads the list, sends each call with
 * `send_calls`, and records the resulting request id + approval URL here so
 * the UI can show "awaiting approval" with the link.
 */
export function controllerRequestRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();
  app.get("/", async (c) => {
    const q = parseQuery(c, ListQuery);
    const requests = await deps.exceptions.listRequests(q.status ?? "pending");
    return respond(c, ListResponse, { requests, treasury: deps.exceptions.treasury });
  });

  app.get("/:id", async (c) => {
    const { id } = parseParams(c, IdParams);
    const request = await deps.exceptions.getRequest(id);
    if (!request) throw new NotFoundError("controller_requests", id);
    return respond(c, ControllerRequestSchema, request);
  });

  /** Records the Wallet MCP submission. 409 `already_submitted` for a different request id, 409 `not_pending` once resolved. */
  app.post("/:id/submission", async (c) => {
    const { id } = parseParams(c, IdParams);
    const body = await parseBody(c, SubmitControllerRequestInputSchema);
    const r = await deps.exceptions.submit(id, body);
    return respond(c, SubmissionResponse, { request: r.request, recorded: r.recorded });
  });
  return app;
}
