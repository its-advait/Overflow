import type { Repositories } from "@overflow/database";
import { keccak256, stringToHex } from "viem";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError } from "./http.js";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

export interface IdempotentRequest {
  key: string;
  /** Operation + target, e.g. "purchases.authorize:<purchaseId>". */
  scope: string;
  method: string;
  path: string;
  body: unknown;
}

export interface IdempotentResult {
  statusCode: ContentfulStatusCode;
  response: unknown;
  /** True when the stored result was returned without running the handler. */
  replayed: boolean;
}

/** Deterministic JSON: sorted keys, undefined members dropped (as JSON.stringify does). */
function canonical(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

/**
 * Hash used only to detect a key reused with a different request. It is a
 * cache key, not a signed digest, so hashing a canonical JSON form is fine
 * here (signed material is always ABI-encoded; see CLAUDE.md).
 */
export function requestHash(req: Pick<IdempotentRequest, "scope" | "method" | "path" | "body">): `0x${string}` {
  return keccak256(stringToHex(canonical({ scope: req.scope, method: req.method, path: req.path, body: req.body ?? null })));
}

/**
 * Runs `handler` once per key. A repeat with the same key and request replays
 * the stored status and body (the handler does not run); the same key with a
 * different request is refused with 422.
 */
export async function withIdempotency(
  repos: Pick<Repositories, "idempotencyKeys">,
  req: IdempotentRequest,
  handler: () => Promise<{ statusCode: ContentfulStatusCode; response: unknown }>,
): Promise<IdempotentResult> {
  if (!req.key || req.key.length > 200) {
    throw new ApiError(400, "idempotency_key_required", `${IDEMPOTENCY_HEADER} header is required (1-200 chars)`);
  }
  const hash = requestHash(req);
  const existing = await repos.idempotencyKeys.get(req.key);
  if (existing) {
    if (existing.requestHash !== hash) {
      throw new ApiError(422, "idempotency_key_reused", `${IDEMPOTENCY_HEADER} was already used for a different request`);
    }
    return { statusCode: existing.statusCode as ContentfulStatusCode, response: existing.response, replayed: true };
  }

  const result = await handler();
  const { inserted, row: stored } = await repos.idempotencyKeys.put({
    key: req.key,
    scope: req.scope,
    requestHash: hash,
    statusCode: result.statusCode,
    response: result.response,
  });
  // A concurrent writer may have won the insert; the stored row is the truth either way.
  if (!inserted && stored.requestHash !== hash) {
    throw new ApiError(422, "idempotency_key_reused", `${IDEMPOTENCY_HEADER} was already used for a different request`);
  }
  return { statusCode: stored.statusCode as ContentfulStatusCode, response: stored.response, replayed: !inserted };
}
