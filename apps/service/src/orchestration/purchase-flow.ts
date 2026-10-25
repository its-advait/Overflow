import { NotFoundError, type Repositories } from "@overflow/database";
import { checkQuote, QuoteMismatchError, type CheckedQuote } from "@overflow/payment-client";
import {
  AddressSchema,
  assertTransition,
  type ExceptionRecord,
  type MissionRecord,
  type PaymentPath,
  type PurchaseOrder,
  type PurchaseRecord,
  type ResourceRecord,
  type ResourceRequestRecord,
  type SampleRecord,
} from "@overflow/schemas";
import { NotWiredError, type OrchestrationPort, type PaymentAdapter, type PaymentSubmission, type PolicyPort, type PreparedPayment } from "../api/ports.js";
import type { ExceptionService } from "../exceptions/service.js";
import type { OrderTermsInput, OrderTermsPort, OrderTerms, ProposeResult } from "./oracle-port.js";
import type { PurchaseService } from "./purchase-service.js";
import type { SampleJudge } from "./sample-judgment.js";

// ---------------------------------------------------------------------------
// The purchase flow of docs/SPEC.md "One purchase, end to end", steps 1 to 7,
// as named functions. Each step makes at most one PurchaseService.transition
// with its evidence; nothing here moves USDC. The chain, through the indexer,
// is the only thing that sets ESCROW_FUNDED, SETTLED or REFUNDED.
//
//   step1_plan        OrchestrationPort.planMission   (orchestration/oracle-port.ts, Oracle extraction)
//   step2_propose     OrchestrationPort.propose       (Oracle recommend + Fusion merge -> PROPOSED rows)
//   step3_orderTerms  OrderTermsPort.prepare          (orchestration/seller-order-terms.ts: the seller's verified order)
//   step4_sample      SampleJudge.judge               (orchestration/sample-judgment.ts)
//   step5_quote       adapter.getPaymentRequirements + checkQuote
//   step6_sign        adapter.preparePayment          -> RESERVED (digest, reservation tx when any)
//   step7_submit      adapter.submitPayment           -> PAYMENT_PENDING, then REJECTED / PAYMENT_UNKNOWN / tx hash appended
//
// runAuthorization = step4 -> step5 -> step6 -> step7, which is what
// POST /api/purchases/:id/authorize runs. Steps 8 to 10 belong to the seller
// worker (reveal), the delivery watcher (verify, accept / complain / timeout)
// and the indexer (settlement).
// ---------------------------------------------------------------------------

/** Step 1: the model proposes requirements, code validates and persists them as resource_requests. */
export const step1_plan = (port: OrchestrationPort, mission: MissionRecord): Promise<ResourceRequestRecord[]> => port.planMission(mission);
/** Step 2: Oracle recommends per open request and Fusion merges; the caller persists the proposals through PurchaseService.propose. */
export const step2_propose = (port: OrchestrationPort, mission: MissionRecord): Promise<ProposeResult> => port.propose(mission);
/** Step 3: the seller's order fixes seller, escrow, termsHash and orderId; the port verifies every hash before they are stored. */
export const step3_orderTerms = (port: OrderTermsPort, input: OrderTermsInput): Promise<OrderTerms> => port.prepare(input);

/** An open LOW_CONFIDENCE_SAMPLE exception holds the purchase: the controller has not decided yet. */
export class SampleHeldError extends Error {
  constructor(
    public readonly purchaseId: string,
    public readonly exceptionId: string,
    public readonly sampleId: string | undefined,
  ) {
    super(`purchase ${purchaseId} is held by LOW_CONFIDENCE_SAMPLE exception ${exceptionId}; decide it before authorizing`);
    this.name = "SampleHeldError";
  }
}

/** The sample ended the purchase before funding (FAILED_BEFORE_FUNDING); nothing was signed. */
export class SampleRefusedError extends Error {
  constructor(
    public readonly purchaseId: string,
    public readonly kind: "skip" | "mismatch" | "declined",
    public readonly reason: string,
    public readonly sample: SampleRecord | undefined,
  ) {
    super(`purchase ${purchaseId} not authorized (${kind}): ${reason}`);
    this.name = "SampleRefusedError";
  }
}

export interface PurchaseFlowDeps {
  purchases: PurchaseService;
  repos: Repositories;
  exceptions: ExceptionService;
  judge: SampleJudge;
  adapters: Partial<Record<PaymentPath, PaymentAdapter>>;
  policy: PolicyPort;
  log?: ((message: string) => void) | undefined;
}

export type Step4Result = { outcome: "buy"; sample: SampleRecord | null } | { outcome: "held"; sample: SampleRecord; exceptionId: string };

export type AuthorizationResult =
  | { outcome: "held"; purchase: PurchaseRecord; sample: SampleRecord; exceptionId: string }
  | { outcome: "submitted"; purchase: PurchaseRecord; sample: SampleRecord | null; authorizationDigest: PreparedPayment["authorizationDigest"]; submission: PaymentSubmission };

/** The order's resource and the adapter for its payment path, or the typed refusals the route already maps. */
export interface LoadedOrder {
  order: PurchaseOrder;
  resource: ResourceRecord;
  adapter: PaymentAdapter;
}

export function createPurchaseFlow(deps: PurchaseFlowDeps) {
  const log = deps.log ?? (() => undefined);

  async function load(purchaseId: string): Promise<LoadedOrder> {
    const order = await deps.repos.purchases.getOrder(purchaseId);
    if (!order) throw new NotFoundError("purchases", purchaseId);
    // Only PROPOSED purchases can be authorized; the refusal names the move it would have been.
    assertTransition(order.status, "RESERVED");
    const resource = await deps.repos.resources.getById(order.resourceId);
    if (!resource) throw new NotFoundError("resources", order.resourceId);
    const adapter = deps.adapters[order.paymentPath];
    if (!adapter) throw new NotWiredError(`payment adapter for ${order.paymentPath}`, "P7.x");
    return { order, resource, adapter };
  }

  async function lowConfidenceExceptions(purchaseId: string): Promise<ExceptionRecord[]> {
    return (await deps.repos.exceptions.list("all")).filter((e) => e.type === "LOW_CONFIDENCE_SAMPLE" && e.purchaseId === purchaseId);
  }

  async function sampleFor(purchaseId: string, exception: ExceptionRecord): Promise<SampleRecord | undefined> {
    const sampleId = typeof exception.details?.sampleId === "string" ? exception.details.sampleId : undefined;
    if (sampleId) {
      const byId = await deps.repos.samples.getById(sampleId);
      if (byId) return byId;
    }
    return (await deps.repos.samples.listByPurchase(purchaseId))[0];
  }

  /**
   * Step 4. Honors the controller's decision on an earlier low-confidence sample first:
   * open -> SampleHeldError (409); rejected -> FAILED_BEFORE_FUNDING; approved -> proceed on
   * the stored sample without a second model call. Otherwise the judge samples and judges.
   */
  async function step4_sample(loaded: LoadedOrder, requestId: string): Promise<Step4Result> {
    const { order, resource } = loaded;
    const exceptions = await lowConfidenceExceptions(order.id);
    const open = exceptions.find((e) => e.status === "open");
    if (open) throw new SampleHeldError(order.id, open.id, typeof open.details?.sampleId === "string" ? open.details.sampleId : undefined);
    const decided = exceptions.filter((e) => e.status !== "open").sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""))[0];
    if (decided?.decision === "reject") {
      const reason = `controller declined the low-confidence sample (exception ${decided.id}${decided.decisionReason ? `: ${decided.decisionReason}` : ""})`;
      await deps.purchases.transition(order.id, "FAILED_BEFORE_FUNDING", {
        reason,
        source: { kind: "api", reference: requestId },
        simulated: resource.simulated,
      });
      throw new SampleRefusedError(order.id, "declined", reason, await sampleFor(order.id, decided));
    }
    if (decided?.decision === "approve") {
      const sample = await sampleFor(order.id, decided);
      log(`[flow] ${order.id}: controller approved the low-confidence sample (exception ${decided.id}); no second model call`);
      return { outcome: "buy", sample: sample ?? null };
    }

    const judged = await deps.judge.judge(order.id);
    switch (judged.outcome) {
      case "buy":
        return { outcome: "buy", sample: judged.sample };
      case "held":
        return judged;
      case "skip":
        throw new SampleRefusedError(order.id, "skip", judged.reason, judged.sample);
      case "failed":
        throw new SampleRefusedError(order.id, "mismatch", judged.reason, undefined);
    }
  }

  /**
   * Step 5. The seller's quote against the order. A quote that disagrees with the order is never
   * signed: the purchase is REJECTED with decodedRevert `QuoteMismatch(<field>)` (the Blocked lane)
   * and the mismatch is rethrown for the route (409 quote_mismatch).
   */
  async function step5_quote(loaded: LoadedOrder, requestId: string): Promise<CheckedQuote> {
    const { order, resource, adapter } = loaded;
    const requirements = await adapter.getPaymentRequirements(order, resource);
    try {
      const approvedDirectSellers = (await deps.policy.allowlistedPayees()).map((a) => AddressSchema.parse(a));
      return checkQuote(requirements, order, { approvedDirectSellers });
    } catch (e) {
      if (e instanceof QuoteMismatchError) {
        const decodedRevert = `QuoteMismatch(${e.field})`;
        await deps.purchases.transition(order.id, "REJECTED", {
          reason: `quote refused, not signed: ${e.message}`,
          source: { kind: "api", reference: requestId },
          decodedRevert,
          simulated: resource.simulated,
        });
      } else {
        await deps.purchases.transition(order.id, "FAILED_BEFORE_FUNDING", {
          reason: `quote refused, not signed: ${e instanceof Error ? e.message : String(e)}`,
          source: { kind: "api", reference: requestId },
          simulated: resource.simulated,
        });
      }
      throw e;
    }
  }

  /** Step 6. Sign (and reserve() on the coinbase path). Authorization is its own event: RESERVED with the digest. */
  async function step6_sign(loaded: LoadedOrder, quote: CheckedQuote): Promise<PreparedPayment> {
    const { order, resource, adapter } = loaded;
    const prepared = await adapter.preparePayment(order.id, quote);
    await deps.purchases.transition(order.id, "RESERVED", {
      reason: `authorization signed for ${quote.value.toString()} atomic USDC to ${quote.payTo}`,
      source: { kind: "adapter", reference: adapter.path },
      authorizationDigest: prepared.authorizationDigest,
      ...(prepared.reservationTxHash ? { txHash: prepared.reservationTxHash } : {}),
      simulated: resource.simulated,
    });
    return prepared;
  }

  /**
   * Step 7. Digest on disk (PAYMENT_PENDING) before the paid request leaves the process, then exactly one
   * submission. rejected -> REJECTED with the decoded revert; unknown -> PAYMENT_UNKNOWN (only reconciliation
   * leaves it); submitted -> the tx hash is appended and the indexer's OrderFunded sets ESCROW_FUNDED.
   */
  async function step7_submit(loaded: LoadedOrder, prepared: PreparedPayment): Promise<{ purchase: PurchaseRecord; submission: PaymentSubmission }> {
    const { order, resource, adapter } = loaded;
    await deps.purchases.transition(order.id, "PAYMENT_PENDING", {
      reason: "submitting payment",
      source: { kind: "adapter", reference: adapter.path },
      authorizationDigest: prepared.authorizationDigest,
      simulated: resource.simulated,
    });
    const submission = await adapter.submitPayment(order.id, prepared);
    let purchase: PurchaseRecord;
    switch (submission.outcome) {
      case "rejected":
        purchase = (
          await deps.purchases.transition(order.id, "REJECTED", {
            reason: `treasury policy revert: ${submission.decodedRevert}`,
            source: { kind: "adapter", reference: adapter.path },
            decodedRevert: submission.decodedRevert,
            simulated: resource.simulated,
          })
        ).purchase;
        break;
      case "unknown":
        purchase = (
          await deps.purchases.transition(order.id, "PAYMENT_UNKNOWN", {
            reason: `broadcast without a receipt: ${submission.error}; reconcile before any retry`,
            source: { kind: "adapter", reference: adapter.path },
            simulated: resource.simulated,
          })
        ).purchase;
        break;
      case "submitted":
        // Funding (ESCROW_FUNDED) is only set by the chain indexer from the confirmed event.
        purchase = await deps.repos.purchases.appendTxHash(order.id, submission.txHash);
        break;
    }
    return { purchase, submission };
  }

  /** Steps 4 to 7 for one purchase. `held` returns early with the purchase still PROPOSED. */
  async function runAuthorization(purchaseId: string, requestId: string): Promise<AuthorizationResult> {
    const loaded = await load(purchaseId);
    const sampled = await step4_sample(loaded, requestId);
    if (sampled.outcome === "held") {
      const purchase = await deps.repos.purchases.getById(purchaseId);
      if (!purchase) throw new NotFoundError("purchases", purchaseId);
      return { outcome: "held", purchase, sample: sampled.sample, exceptionId: sampled.exceptionId };
    }
    const quote = await step5_quote(loaded, requestId);
    const prepared = await step6_sign(loaded, quote);
    const { purchase, submission } = await step7_submit(loaded, prepared);
    return { outcome: "submitted", purchase, sample: sampled.sample, authorizationDigest: prepared.authorizationDigest, submission };
  }

  return { load, step4_sample, step5_quote, step6_sign, step7_submit, runAuthorization };
}
export type PurchaseFlow = ReturnType<typeof createPurchaseFlow>;
