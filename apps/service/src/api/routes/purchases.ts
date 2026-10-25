import { checkQuote, type CheckedQuote } from "@overflow/payment-client";
import {
  ActivityEventSchema,
  AddressSchema,
  Bytes32Schema,
  ChainTransactionSchema,
  EscrowOrderSchema,
  IdSchema,
  PurchaseRecordSchema,
  type PurchaseRecord,
} from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { ApiError, parseBody, parseParams, respond, type ApiEnv } from "../http.js";
import { IDEMPOTENCY_HEADER, withIdempotency } from "../idempotency.js";
import { FusionOutcomeSchema, OracleDecisionSchema } from "../../orchestration/oracle-port.js";
import { loadMission } from "./missions.js";

const IdParams = z.object({ id: IdSchema });

const ProposeBody = z.object({ missionId: IdSchema });
const ProposeResponse = z.object({
  purchases: z.array(PurchaseRecordSchema),
  /** One per open request: what Oracle chose, what it rejected and why. A decision authorizes no payment. */
  decisions: z.array(OracleDecisionSchema),
  /** One per Fusion decision: merged or not, every rule with evidence, the paying node. Authorizes nothing. */
  merges: z.array(FusionOutcomeSchema),
});

const PurchaseResponse = z.object({
  purchase: PurchaseRecordSchema,
  escrow: EscrowOrderSchema.nullable(),
  chainTransactions: z.array(ChainTransactionSchema),
  activity: z.array(ActivityEventSchema),
});

/** Optional: lets the caller pin the seller URL the 402 is fetched from; the order fields always win. */
const AuthorizeBody = z.object({ note: z.string().max(500).optional() }).default({});

export const SubmissionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("submitted"), txHash: Bytes32Schema }),
  z.object({ outcome: z.literal("rejected"), decodedRevert: z.string() }),
  z.object({ outcome: z.literal("unknown"), error: z.string() }),
]);

export const AuthorizeResponse = z.object({
  purchase: PurchaseRecordSchema,
  authorizationDigest: Bytes32Schema,
  /** What the adapter reported. Funding itself is only ever set from a confirmed chain event. */
  submission: SubmissionSchema,
  replayed: z.boolean(),
});

export function purchaseRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();

  /** Oracle recommendation per open request, Fusion merge of compatible ones, persisted as PROPOSED rows by the PurchaseService. */
  app.post("/propose", async (c) => {
    const { missionId } = await parseBody(c, ProposeBody);
    const mission = await loadMission(deps, c.get("session").organizationId, missionId);
    const { proposals, decisions, merges } = await deps.ports.orchestration.propose(mission);
    const purchases: PurchaseRecord[] = [];
    for (const p of proposals) purchases.push((await deps.purchases.propose(p)).purchase);
    return respond(c, ProposeResponse, { purchases, decisions, merges }, 201);
  });

  /**
   * Agent-side authorization. Loads the order, fetches the seller's quote
   * through the adapter for the order's payment path, refuses any quote that
   * disagrees with the order (never signed), then RESERVED -> PAYMENT_PENDING
   * before the adapter submits. The chain, not this route, decides funding.
   */
  app.post("/:id/authorize", async (c) => {
    const { id } = parseParams(c, IdParams);
    const body = await parseBody(c, AuthorizeBody);
    const requestId = c.get("requestId");
    const key = c.req.header(IDEMPOTENCY_HEADER) ?? "";

    const result = await withIdempotency(
      deps.repos,
      { key, scope: `purchases.authorize:${id}`, method: "POST", path: c.req.path, body },
      async () => {
        const response = await authorize(deps, id, requestId);
        return { statusCode: 202, response };
      },
    );
    const parsed = AuthorizeResponse.parse({ ...(result.response as object), replayed: result.replayed });
    return c.json(parsed, result.statusCode);
  });

  app.get("/:id", async (c) => {
    const { id } = parseParams(c, IdParams);
    const purchase = await loadPurchase(deps, c.get("session").organizationId, id);
    const [escrow, chainTransactions, activity] = await Promise.all([
      deps.repos.escrowOrders.getByPurchase(id),
      deps.repos.chainTransactions.listByPurchase(id),
      deps.repos.activityEvents.listByPurchase(id),
    ]);
    return respond(c, PurchaseResponse, { purchase, escrow: escrow ?? null, chainTransactions, activity });
  });

  return app;
}

export async function loadPurchase(deps: ApiDeps, organizationId: string, id: string): Promise<PurchaseRecord> {
  const purchase = await deps.repos.purchases.getById(id);
  if (!purchase) throw new ApiError(404, "not_found", `purchase ${id} not found`);
  await loadMission(deps, organizationId, purchase.missionId);
  return purchase;
}

type AuthorizeResult = Omit<z.input<typeof AuthorizeResponse>, "replayed">;

async function authorize(deps: ApiDeps, id: string, requestId: string): Promise<AuthorizeResult> {
  const order = await deps.repos.purchases.getOrder(id);
  if (!order) throw new ApiError(404, "not_found", `purchase ${id} not found`);
  if (order.status !== "PROPOSED") {
    throw new ApiError(409, "invalid_transition", `purchase ${id} is ${order.status}; only PROPOSED purchases can be authorized`, {
      from: order.status,
      to: "RESERVED",
    });
  }
  const resource = await deps.repos.resources.getById(order.resourceId);
  if (!resource) throw new ApiError(404, "not_found", `resource ${order.resourceId} not found`);

  const adapter = deps.ports.adapters[order.paymentPath];
  if (!adapter) {
    throw new ApiError(501, "not_wired", `no payment adapter for ${order.paymentPath} (lands in P7.x)`, {
      paymentPath: order.paymentPath,
    });
  }

  // 1. Quote versus order. A mismatch is never signed; the purchase ends before funding.
  const requirements = await adapter.getPaymentRequirements(order, resource);
  let quote: CheckedQuote;
  try {
    const approvedDirectSellers = (await deps.ports.policy.allowlistedPayees()).map((a) => AddressSchema.parse(a));
    quote = checkQuote(requirements, order, { approvedDirectSellers });
  } catch (e) {
    await deps.purchases.transition(id, "FAILED_BEFORE_FUNDING", {
      reason: `quote refused, not signed: ${e instanceof Error ? e.message : String(e)}`,
      source: { kind: "api", reference: requestId },
      simulated: resource.simulated,
    });
    throw e;
  }

  // 2. Sign (and reserve() on the coinbase path). Authorization is its own event.
  const prepared = await adapter.preparePayment(id, quote);
  await deps.purchases.transition(id, "RESERVED", {
    reason: `authorization signed for ${quote.value.toString()} atomic USDC to ${quote.payTo}`,
    source: { kind: "adapter", reference: adapter.path },
    authorizationDigest: prepared.authorizationDigest,
    ...(prepared.reservationTxHash ? { txHash: prepared.reservationTxHash } : {}),
    simulated: resource.simulated,
  });

  // 3. Digest on disk before the paid request leaves the process.
  await deps.purchases.transition(id, "PAYMENT_PENDING", {
    reason: "submitting payment",
    source: { kind: "adapter", reference: adapter.path },
    authorizationDigest: prepared.authorizationDigest,
    simulated: resource.simulated,
  });

  // 4. Exactly one submission. Never a new nonce after this point.
  const submission = await adapter.submitPayment(id, prepared);
  let purchase: PurchaseRecord;
  switch (submission.outcome) {
    case "rejected":
      purchase = (
        await deps.purchases.transition(id, "REJECTED", {
          reason: `treasury policy revert: ${submission.decodedRevert}`,
          source: { kind: "adapter", reference: adapter.path },
          decodedRevert: submission.decodedRevert,
          simulated: resource.simulated,
        })
      ).purchase;
      break;
    case "unknown":
      purchase = (
        await deps.purchases.transition(id, "PAYMENT_UNKNOWN", {
          reason: `broadcast without a receipt: ${submission.error}; reconcile before any retry`,
          source: { kind: "adapter", reference: adapter.path },
          simulated: resource.simulated,
        })
      ).purchase;
      break;
    case "submitted":
      // Funding (ESCROW_FUNDED) is only set by the chain indexer from the confirmed event.
      purchase = await deps.repos.purchases.appendTxHash(id, submission.txHash);
      break;
  }

  return { purchase, authorizationDigest: prepared.authorizationDigest, submission };
}
