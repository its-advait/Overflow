import { z } from "zod";
import { ActivityEventSchema, EscrowStatusSchema } from "./ledger";
import { AddressSchema, AtomicAmountSchema, Bytes32Schema, IdSchema, IsoDateTimeSchema, UintStringSchema } from "./primitives";
import { PurchaseStatusSchema } from "./purchase";
import { ChainTransactionSchema, ComplaintRecordSchema, EscrowOrderSchema, PurchaseRecordSchema, SampleRecordSchema } from "./tables";

// ---------------------------------------------------------------------------
// Recourse read models (docs/SPEC.md "Recourse"): what GET /api/escrow and
// GET /api/escrow/:id return. Every field is either a stored record, a view
// call made for this response, or a gate derived from those two; nothing here
// is a success the chain did not confirm.
// ---------------------------------------------------------------------------

/** The escrow as the chain holds it right now (eth_call at one block). */
export const EscrowChainStateSchema = z.object({
  status: EscrowStatusSchema,
  /** Unix seconds; "0" until the key is revealed. */
  challengeEnd: UintStringSchema,
  /** bytes32(0) until the key is revealed. */
  revealedKey: Bytes32Schema,
  /** USDC held by the escrow at `blockNumber`. */
  balanceAtomic: AtomicAmountSchema,
  blockNumber: UintStringSchema,
  /** Unix seconds of that block: the clock the contract's deadlines are judged against. */
  blockTimestamp: UintStringSchema,
});
export type EscrowChainState = z.infer<typeof EscrowChainStateSchema>;

/**
 * Whether the contract would accept one call right now. `reason` names the revert the contract would raise
 * (BadStatus, ChallengeOpen, ...) when it would not; `availableAt` / `until` are unix seconds.
 */
export const ActionGateSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().min(1),
  /** Who may send it: "anyone", "seller", "treasury node key". */
  who: z.string().min(1),
  availableAt: UintStringSchema.optional(),
  until: UintStringSchema.optional(),
});
export type ActionGate = z.infer<typeof ActionGateSchema>;

export const ESCROW_ACTIONS = ["accept", "finalizePayout", "claimTimeoutRefund", "complain", "sweep"] as const;
export const EscrowActionSchema = z.enum(ESCROW_ACTIONS);
export type EscrowAction = z.infer<typeof EscrowActionSchema>;

export const EscrowActionsSchema = z.object({
  accept: ActionGateSchema,
  finalizePayout: ActionGateSchema,
  claimTimeoutRefund: ActionGateSchema,
  complain: ActionGateSchema,
  sweep: ActionGateSchema,
  /** The clock the gates were judged at (unix seconds): the chain's block timestamp, never the wall clock. */
  asOf: UintStringSchema,
});
export type EscrowActions = z.infer<typeof EscrowActionsSchema>;

export const EscrowResourceSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  sellerId: IdSchema,
  simulated: z.boolean(),
});

export const EscrowDetailResponseSchema = z.object({
  escrow: EscrowOrderSchema,
  purchase: PurchaseRecordSchema,
  resource: EscrowResourceSchema.nullable(),
  /** null when the service has no chain reader; `chainUnavailable` then says why. Stored data still renders. */
  chain: EscrowChainStateSchema.nullable(),
  chainUnavailable: z.string().min(1).optional(),
  chainTransactions: z.array(ChainTransactionSchema),
  sample: SampleRecordSchema.nullable(),
  complaint: ComplaintRecordSchema.nullable(),
  actions: EscrowActionsSchema.nullable(),
  activity: z.array(ActivityEventSchema),
  /** True when the seller, dataset or judge is simulated (labelled in the UI). */
  simulated: z.boolean(),
});
export type EscrowDetailResponse = z.infer<typeof EscrowDetailResponseSchema>;

export const EscrowSummarySchema = z.object({
  id: IdSchema,
  purchaseId: IdSchema,
  escrowAddress: AddressSchema,
  sellerAddress: AddressSchema,
  amountAtomic: AtomicAmountSchema,
  bondAtomic: AtomicAmountSchema,
  status: EscrowStatusSchema,
  refundReason: z.string().optional(),
  purchaseStatus: PurchaseStatusSchema,
  resource: EscrowResourceSchema.nullable(),
  /** Set when a complaint exists for the order. */
  complaint: z.enum(["built", "submitted", "proven", "rejected"]).optional(),
  simulated: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type EscrowSummary = z.infer<typeof EscrowSummarySchema>;

export const EscrowListResponseSchema = z.object({ escrows: z.array(EscrowSummarySchema) });
export type EscrowListResponse = z.infer<typeof EscrowListResponseSchema>;
