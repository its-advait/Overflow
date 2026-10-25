import {
  createRepositories,
  isUniqueViolation,
  NotFoundError,
  type Executor,
  type PurchaseInsert,
} from "@overflow/database";
import {
  assertTransition,
  Bytes32Schema,
  EscrowStatusSchema,
  IdSchema,
  PurchaseStatusSchema,
  type ActivityEvent,
  type ActivityKind,
  type EscrowOrder,
  type PurchaseRecord,
  type PurchaseStatus,
  UintStringSchema,
} from "@overflow/schemas";
import { z } from "zod";
import type { EscrowTermsForRow } from "./oracle-port.js";

// ---------------------------------------------------------------------------
// PurchaseService: the one code path that moves a purchase along the state
// machine (docs/SPEC.md "Purchase state machine"). Every move is checked with
// assertTransition from @overflow/schemas and recorded as an activity_event
// carrying the reason and the source reference, in the same transaction.
//
// It never moves USDC. Entering ESCROW_FUNDED / SETTLED / REFUNDED requires a
// confirmed chain transaction hash, so no row can claim funding or settlement
// that the chain has not confirmed.
//
// The escrow_orders mirror moves through here as well: evidence may carry the
// escrow status a confirmed escrow event established, applied in the same
// transaction. Nothing else writes purchases.status or escrow_orders.status.
// ---------------------------------------------------------------------------

export const TransitionSourceSchema = z.object({
  /** Who observed the fact that justifies the move. */
  kind: z.enum(["api", "adapter", "chain", "reconciliation", "seller", "oracle"]),
  /** Request id, adapter name, transaction hash, job run id, ... */
  reference: z.string().min(1),
});
export type TransitionSource = z.infer<typeof TransitionSourceSchema>;

export const TransitionEvidenceSchema = z.object({
  reason: z.string().min(1),
  source: TransitionSourceSchema,
  /** Confirmed transaction hash; required for chain-truth states. */
  txHash: Bytes32Schema.optional(),
  /** EIP-3009 digest; required before PAYMENT_PENDING. */
  authorizationDigest: Bytes32Schema.optional(),
  /** Decoded treasury revert, e.g. "OverBudget(3)"; required for REJECTED. */
  decodedRevert: z.string().min(1).optional(),
  agentId: IdSchema.optional(),
  simulated: z.boolean().default(false),
  /** Escrow status the same confirmed event established (OrderFunded, KeyRevealed, PaidOut, Refunded). */
  escrow: z
    .object({
      status: EscrowStatusSchema,
      revealedKey: Bytes32Schema.optional(),
      /** Unix seconds; KeyRevealed's challengeEnd. */
      challengeEnd: UintStringSchema.optional(),
      refundReason: z.string().min(1).optional(),
    })
    .optional(),
});
export type TransitionEvidence = z.input<typeof TransitionEvidenceSchema>;

/** States only a confirmed chain event may establish. */
export const CHAIN_TRUTH_STATUSES: readonly PurchaseStatus[] = ["ESCROW_FUNDED", "SETTLED", "REFUNDED"];

export class TransitionEvidenceError extends Error {
  constructor(
    public readonly to: PurchaseStatus,
    message: string,
  ) {
    super(`cannot enter ${to}: ${message}`);
    this.name = "TransitionEvidenceError";
  }
}

/** Second active purchase for the same (mission, resource). */
export class ActivePurchaseExistsError extends Error {
  constructor(
    public readonly missionId: string,
    public readonly resourceId: string,
  ) {
    super(`an active purchase already exists for mission ${missionId} and resource ${resourceId}`);
    this.name = "ActivePurchaseExistsError";
  }
}

const KIND_BY_STATUS: Partial<Record<PurchaseStatus, ActivityKind>> = {
  RESERVED: "payment.authorized",
  PAYMENT_PENDING: "payment.authorized",
  ESCROW_FUNDED: "escrow.funded",
  SETTLED: "escrow.settled",
  REFUNDED: "escrow.refunded",
  REJECTED: "policy.blocked",
};

function checkEvidence(from: PurchaseStatus, to: PurchaseStatus, ev: z.output<typeof TransitionEvidenceSchema>): void {
  if (CHAIN_TRUTH_STATUSES.includes(to)) {
    if (!ev.txHash) throw new TransitionEvidenceError(to, "a confirmed txHash is required");
    if (ev.source.kind !== "chain" && ev.source.kind !== "reconciliation") {
      throw new TransitionEvidenceError(to, `source must be chain or reconciliation, got ${ev.source.kind}`);
    }
  }
  if (to === "REJECTED" && !ev.decodedRevert) {
    throw new TransitionEvidenceError(to, "the decoded policy revert is required");
  }
  if (to === "PAYMENT_PENDING" && !ev.authorizationDigest) {
    throw new TransitionEvidenceError(to, "the authorization digest must be recorded before the paid request");
  }
  if (from === "PAYMENT_UNKNOWN" && ev.source.kind !== "reconciliation") {
    throw new TransitionEvidenceError(to, "only reconciliation against the chain may leave PAYMENT_UNKNOWN");
  }
  if (ev.escrow && !ev.txHash) {
    throw new TransitionEvidenceError(to, "an escrow status needs the confirmed txHash of the escrow event");
  }
}

export interface TransitionResult {
  purchase: PurchaseRecord;
  event: ActivityEvent;
  /** The escrow_orders row after `evidence.escrow` was applied; undefined when no row exists yet or none was requested. */
  escrow?: EscrowOrder | undefined;
  /** propose() only: the idempotencyKey already had a purchase; nothing was written and `event` is the original one. */
  replayed?: boolean | undefined;
}

export interface PurchaseServiceOptions {
  /** Called after each commit with the activity event written (live feed). Never before commit. */
  publish?: ((event: ActivityEvent) => void) | undefined;
}

export interface ProposeInput {
  purchase: PurchaseInsert;
  /** Fusion merge of two or more requests: a purchase_groups row is written in the same transaction and linked. */
  group?: { payingNodeId: number; requestIds: string[]; mergeReason: string } | undefined;
  /** The seller's verified terms: an escrow_orders row (status `Created`) is written in the same transaction. */
  escrow?: EscrowTermsForRow | undefined;
  reason: string;
  source: TransitionSource;
  agentId?: string | undefined;
  simulated?: boolean | undefined;
}

export function createPurchaseService(db: Executor, options: PurchaseServiceOptions = {}) {
  const publish = (event: ActivityEvent): void => {
    try {
      options.publish?.(event);
    } catch (e) {
      console.warn("[purchases] publish hook threw", e);
    }
  };
  return {
    /**
     * Records a PROPOSED purchase (idempotent on idempotencyKey) and its
     * `purchase.proposed` event. A repeat of the same key returns the stored
     * purchase and its original event without writing anything. A second
     * active purchase for the same (mission, resource) throws
     * ActivePurchaseExistsError.
     */
    async propose(input: ProposeInput): Promise<TransitionResult> {
      const source = TransitionSourceSchema.parse(input.source);
      let result: TransitionResult;
      try {
        result = await db.transaction(async (tx) => {
          const repos = createRepositories(tx);
          const existing = await repos.purchases.getByIdempotencyKey(input.purchase.idempotencyKey);
          if (existing) {
            const events = await repos.activityEvents.listByPurchase(existing.id);
            const event = events.find((e) => e.kind === "purchase.proposed") ?? events[0];
            if (!event) throw new NotFoundError("activity_events", existing.id);
            const escrow = await repos.escrowOrders.getByPurchase(existing.id);
            return { purchase: existing, event, escrow, replayed: true };
          }
          let purchaseGroupId = input.purchase.purchaseGroupId;
          if (input.group) {
            const group = await repos.purchaseGroups.insert({
              missionId: input.purchase.missionId,
              resourceId: input.purchase.resourceId,
              payingNodeId: input.group.payingNodeId,
              requestIds: input.group.requestIds,
              mergeReason: input.group.mergeReason,
            });
            purchaseGroupId = group.id;
          }
          const purchase = await repos.purchases.create({ ...input.purchase, ...(purchaseGroupId ? { purchaseGroupId } : {}) });
          // The seller's terms mirror; it enters Funded/Revealed/Settled/Refunded only through confirmed chain events.
          const escrow = input.escrow ? await repos.escrowOrders.insert({ ...input.escrow, purchaseId: purchase.id }) : undefined;
          const event = await repos.activityEvents.insert({
            kind: "purchase.proposed",
            message: `proposed ${purchase.amountAtomic} atomic USDC for resource ${purchase.resourceId}: ${input.reason} [${source.kind}:${source.reference}]`,
            purchaseId: purchase.id,
            missionId: purchase.missionId,
            ...(input.agentId ? { agentId: input.agentId } : {}),
            simulated: input.simulated ?? false,
          });
          return { purchase, event, escrow };
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new ActivePurchaseExistsError(input.purchase.missionId, input.purchase.resourceId);
        }
        throw e;
      }
      if (!result.replayed) publish(result.event);
      return result;
    },

    /**
     * Moves purchaseId to `to`. Refuses illegal moves (InvalidTransitionError)
     * and moves without the required evidence (TransitionEvidenceError); in
     * both cases nothing is written. Otherwise updates the row, stores the
     * digest / tx hash carried by the evidence, applies the escrow status the
     * evidence carries (when an escrow_orders row exists), and writes one
     * activity event.
     */
    async transition(purchaseId: string, to: PurchaseStatus, evidence: TransitionEvidence): Promise<TransitionResult> {
      const target = PurchaseStatusSchema.parse(to);
      const ev = TransitionEvidenceSchema.parse(evidence);
      const result = await db.transaction(async (tx) => {
        const repos = createRepositories(tx);
        const current = await repos.purchases.getById(purchaseId);
        if (!current) throw new NotFoundError("purchases", purchaseId);
        assertTransition(current.status, target);
        checkEvidence(current.status, target, ev);

        let purchase = await repos.purchases.transition(purchaseId, target);
        if (ev.authorizationDigest && purchase.authorizationDigest !== ev.authorizationDigest) {
          purchase = await repos.purchases.setAuthorizationDigest(purchaseId, ev.authorizationDigest);
        }
        if (ev.txHash) purchase = await repos.purchases.appendTxHash(purchaseId, ev.txHash);

        let escrow: EscrowOrder | undefined;
        if (ev.escrow) {
          const existing = await repos.escrowOrders.getByPurchase(purchaseId);
          if (existing) {
            escrow = await repos.escrowOrders.setStatus(purchaseId, ev.escrow.status, {
              ...(ev.escrow.revealedKey ? { revealedKey: ev.escrow.revealedKey } : {}),
              ...(ev.escrow.challengeEnd ? { challengeEnd: ev.escrow.challengeEnd } : {}),
              ...(ev.escrow.refundReason ? { refundReason: ev.escrow.refundReason } : {}),
            });
          }
        }

        const event = await repos.activityEvents.insert({
          kind: KIND_BY_STATUS[target] ?? "purchase.status",
          message: `${current.status} -> ${target}: ${ev.reason} [${ev.source.kind}:${ev.source.reference}]`,
          purchaseId,
          missionId: purchase.missionId,
          ...(ev.agentId ? { agentId: ev.agentId } : {}),
          ...(ev.decodedRevert ? { decodedRevert: ev.decodedRevert } : {}),
          ...(ev.txHash ? { txHash: ev.txHash } : {}),
          simulated: ev.simulated,
        });
        return { purchase, event, escrow };
      });
      publish(result.event);
      return result;
    },

    async get(purchaseId: string): Promise<PurchaseRecord | undefined> {
      return createRepositories(db).purchases.getById(purchaseId);
    },
  };
}
export type PurchaseService = ReturnType<typeof createPurchaseService>;
