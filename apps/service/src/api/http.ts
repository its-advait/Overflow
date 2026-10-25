import { AlreadySubmittedError, InvalidEscrowTransitionError, NotFoundError, RequestNotPendingError, UniqueViolationError } from "@overflow/database";
import { ExtractionError } from "@overflow/oracle";
import { QuoteMismatchError } from "@overflow/payment-client";
import { InvalidTransitionError } from "@overflow/schemas";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z, ZodError } from "zod";
import { ExceptionAlreadyDecidedError, OnchainApprovalRequiredError, SelfResolutionError } from "../exceptions/service.js";
import { NoOpenRequestsError, OracleUnavailableError, RequirementsUnconfirmedError } from "../orchestration/oracle-port.js";
import { ActivePurchaseExistsError, TransitionEvidenceError } from "../orchestration/purchase-service.js";
import { NotWiredError } from "./ports.js";
import type { Session } from "./session.js";

/** Hono environment: every handler sees the demo session and a request id. */
export type ApiEnv = { Variables: { session: Session; requestId: string } };

export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/** Maps every known failure to one error envelope; unknown errors become a 500 with no stack. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof ZodError) return new ApiError(400, "validation_error", "request failed validation", e.issues);
  if (e instanceof NotFoundError) return new ApiError(404, "not_found", e.message, { table: e.table, id: e.id });
  if (e instanceof InvalidTransitionError) {
    return new ApiError(409, "invalid_transition", e.message, { from: e.from, to: e.to });
  }
  if (e instanceof TransitionEvidenceError) return new ApiError(409, "missing_evidence", e.message, { to: e.to });
  if (e instanceof InvalidEscrowTransitionError) {
    return new ApiError(409, "invalid_escrow_transition", e.message, { from: e.from, to: e.to });
  }
  if (e instanceof ActivePurchaseExistsError) {
    return new ApiError(409, "active_purchase_exists", e.message, { missionId: e.missionId, resourceId: e.resourceId });
  }
  if (e instanceof UniqueViolationError) return new ApiError(409, "conflict", e.message, { constraint: e.constraint });
  if (e instanceof QuoteMismatchError) {
    return new ApiError(409, "quote_mismatch", e.message, { field: e.field, expected: e.expected, actual: e.actual });
  }
  if (e instanceof SelfResolutionError) {
    return new ApiError(403, "self_resolution", e.message, { exceptionId: e.exceptionId, principal: e.principal });
  }
  if (e instanceof ExceptionAlreadyDecidedError) {
    return new ApiError(409, "already_decided", e.message, { exceptionId: e.exceptionId, status: e.status });
  }
  if (e instanceof OnchainApprovalRequiredError) {
    return new ApiError(409, "onchain_approval_required", e.message, { exceptionId: e.exceptionId, requestId: e.requestId });
  }
  if (e instanceof AlreadySubmittedError) return new ApiError(409, "already_submitted", e.message, { id: e.id, existing: e.existing });
  if (e instanceof RequestNotPendingError) return new ApiError(409, "not_pending", e.message, { id: e.id, status: e.status });
  if (e instanceof NotWiredError) return new ApiError(501, "not_wired", e.message, { port: e.port, lands: e.lands });
  if (e instanceof OracleUnavailableError) return new ApiError(503, "oracle_unavailable", e.message, { reason: e.reason });
  if (e instanceof ExtractionError) {
    // Both attempts are already audited as oracle.model_call rows; the response carries their hashes.
    return new ApiError(502, "oracle_extraction_failed", e.message, { issues: e.issues, modelCalls: e.modelCalls });
  }
  if (e instanceof NoOpenRequestsError) return new ApiError(409, "no_open_requests", e.message, { missionId: e.missionId });
  if (e instanceof RequirementsUnconfirmedError) {
    return new ApiError(409, "requirements_unconfirmed", e.message, { missionId: e.missionId });
  }
  return new ApiError(500, "internal_error", "internal error");
}

export function errorResponse(c: Context<ApiEnv>, e: unknown): Response {
  const err = toApiError(e);
  if (err.status === 500) console.error(`[api] ${c.get("requestId")} ${c.req.method} ${c.req.path}`, e);
  const body: ErrorBody = {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
      requestId: c.get("requestId"),
    },
  };
  return c.json(body, err.status);
}

/** Reads and validates a JSON body. A missing or malformed body is a 400. */
export async function parseBody<S extends z.ZodType>(c: Context<ApiEnv>, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "request body must be JSON");
  }
  return schema.parse(raw);
}

export function parseQuery<S extends z.ZodType>(c: Context<ApiEnv>, schema: S): z.output<S> {
  return schema.parse(c.req.query());
}

export function parseParams<S extends z.ZodType>(c: Context<ApiEnv>, schema: S): z.output<S> {
  return schema.parse(c.req.param());
}

/** Validates the response against its schema before sending (Zod out as well as in). */
export function respond<S extends z.ZodType>(
  c: Context<ApiEnv>,
  schema: S,
  data: z.input<S>,
  status: ContentfulStatusCode = 200,
): Response {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    console.error(`[api] ${c.get("requestId")} response failed its schema`, parsed.error.issues);
    throw new ApiError(500, "response_schema_violation", "response failed its schema");
  }
  return c.json(parsed.data as object, status);
}
