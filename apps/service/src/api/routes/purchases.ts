import {
  ActivityEventSchema,
  Bytes32Schema,
  ChainTransactionSchema,
  EscrowOrderSchema,
  IdSchema,
  PurchaseRecordSchema,
  SampleVerdictSchema,
  type PurchaseRecord,
  type SampleRecord,
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
  /** Step 4 ended with a low-confidence "buy": nothing signed, the purchase stays PROPOSED until the controller decides the exception. */
  z.object({ outcome: z.literal("held"), exceptionId: IdSchema }),
]);

/** The Oracle's sample judgment (step 4) this authorization ran or reused. It authorizes nothing. */
export const SampleSummarySchema = z.object({
  id: IdSchema,
  verdict: SampleVerdictSchema,
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string(),
});

export const AuthorizeResponse = z.object({
  purchase: PurchaseRecordSchema,
  /** Absent when the outcome is `held`: nothing was signed. */
  authorizationDigest: Bytes32Schema.optional(),
  /** What the adapter reported. Funding itself is only ever set from a confirmed chain event. */
  submission: SubmissionSchema,
  /** null when the controller approved an earlier sample whose row is gone (never in practice) or the flow did not sample. */
  sample: SampleSummarySchema.nullable(),
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
   * Agent-side authorization: steps 4 to 7 (sample judgment, quote versus order, sign, submit) through the
   * purchase flow. 202 with `submission.outcome` submitted / rejected / unknown / held. The chain, not this
   * route, decides funding.
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

/**
 * Steps 4 to 7 of the purchase flow (orchestration/purchase-flow.ts): sample and judge, quote versus order,
 * sign, submit. A low-confidence sample holds the purchase (PROPOSED) behind a LOW_CONFIDENCE_SAMPLE exception;
 * skip / mismatch / quote mismatch end it before funding and answer 409. The chain, not this route, decides funding.
 */
async function authorize(deps: ApiDeps, id: string, requestId: string): Promise<AuthorizeResult> {
  const result = await deps.flow.runAuthorization(id, requestId);
  const sample = result.sample ? summarize(result.sample) : null;
  if (result.outcome === "held") {
    return { purchase: result.purchase, submission: { outcome: "held", exceptionId: result.exceptionId }, sample };
  }
  return { purchase: result.purchase, authorizationDigest: result.authorizationDigest, submission: result.submission, sample };
}

const summarize = (s: SampleRecord): z.input<typeof SampleSummarySchema> => ({
  id: s.id,
  verdict: s.verdict,
  ...(s.confidence !== undefined ? { confidence: s.confidence } : {}),
  reason: s.reason,
});
