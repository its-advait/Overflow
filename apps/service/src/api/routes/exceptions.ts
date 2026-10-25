import { ControllerRequestSchema, ExceptionRecordSchema, ExceptionStatusSchema, IdSchema } from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import { DecideExceptionInputSchema, RaiseExceptionInputSchema } from "../../exceptions/service.js";
import type { ApiDeps } from "../deps.js";
import { parseBody, parseParams, parseQuery, respond, type ApiEnv } from "../http.js";

const ListQuery = z.object({ status: ExceptionStatusSchema.or(z.literal("all")).optional() });
const ExceptionWithRequest = ExceptionRecordSchema.extend({ request: ControllerRequestSchema.nullable() });
const ListResponse = z.object({ exceptions: z.array(ExceptionWithRequest) });
const DecideResponse = z.object({ exception: ExceptionRecordSchema, request: ControllerRequestSchema.nullable() });
const RaiseResponse = z.object({
  exception: ExceptionRecordSchema,
  request: ControllerRequestSchema.nullable(),
  /** False when an open exception for the same subject already existed and was returned instead. */
  created: z.boolean(),
});
const IdParams = z.object({ id: IdSchema });

/**
 * Exceptions: every case where Overflow asks a human. GET lists them with the
 * prepared ControllerRequest (if any). POST /:id/decide records the
 * controller's offchain decision; an onchain exception can only be rejected
 * here, because approval happens in Coinbase Wallet and the indexer closes it.
 * The requester may never decide its own exception (403). POST / raises one
 * (an agent or operator proposing); onchain types get a pending
 * ControllerRequest with the owner calldata, nothing is executed.
 */
export function exceptionRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();

  app.get("/", async (c) => {
    const q = parseQuery(c, ListQuery);
    const exceptions = await deps.exceptions.list(q.status ?? "open");
    return respond(c, ListResponse, { exceptions });
  });

  app.post("/", async (c) => {
    const body = await parseBody(c, RaiseExceptionInputSchema);
    const r = await deps.exceptions.raise(body);
    return respond(c, RaiseResponse, { exception: r.exception, request: r.request ?? null, created: r.created }, r.created ? 202 : 200);
  });

  app.post("/:id/decide", async (c) => {
    const { id } = parseParams(c, IdParams);
    const body = await parseBody(c, DecideExceptionInputSchema);
    const r = await deps.exceptions.decide(id, body);
    return respond(c, DecideResponse, { exception: r.exception, request: r.request ?? null });
  });

  return app;
}
