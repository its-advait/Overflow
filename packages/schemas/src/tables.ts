import { z } from "zod";
import { LedgerAccountSchema } from "./ledger";
import { MissionSchema } from "./mission";
import {
  AddressSchema,
  AtomicAmountSchema,
  Bytes32Schema,
  IdSchema,
  IsoDateTimeSchema,
  UintStringSchema,
} from "./primitives";
import { AllocationSchema, PurchaseOrderSchema } from "./purchase";
import { ResourceListingSchema, ResourceRequestSchema } from "./resource";

// ---------------------------------------------------------------------------
// Database row schemas (docs/SPEC.md "Database tables").
// Every repository in @overflow/database returns objects validated by one of
// these. Amounts are atomic USDC strings; times are ISO-8601 with offset.
// Schemas that already exist elsewhere (Mission, PurchaseOrder, Allocation,
// ActivityEvent, ExceptionRecord, ControllerRequest) are reused or extended.
// ---------------------------------------------------------------------------

/** The company whose agents buy data. The demo company is fictional and flagged `simulated`. */
export const OrganizationSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  departments: z.array(z.string().min(1)).min(1),
  treasuryAddress: AddressSchema.optional(),
  /** True for the fictional demo company; the UI must label it. */
  simulated: z.boolean().default(false),
  createdAt: IsoDateTimeSchema,
});
export type Organization = z.infer<typeof OrganizationSchema>;

/** Offchain agent record. `nodeId` is null until the treasury node exists onchain. */
export const AgentRecordSchema = z.object({
  id: IdSchema,
  organizationId: IdSchema,
  name: z.string().min(1),
  department: z.string().min(1),
  role: z.string().min(1),
  nodeId: z.number().int().positive().optional(),
  key: AddressSchema,
  parentAgentId: IdSchema.optional(),
  createdAt: IsoDateTimeSchema,
});
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

export const MissionRecordSchema = MissionSchema.extend({ organizationId: IdSchema });
export type MissionRecord = z.infer<typeof MissionRecordSchema>;

export const RESOURCE_REQUEST_STATUSES = ["open", "matched", "purchased", "withdrawn"] as const;
export const ResourceRequestStatusSchema = z.enum(RESOURCE_REQUEST_STATUSES);

export const ResourceRequestRecordSchema = ResourceRequestSchema.extend({
  id: IdSchema,
  missionId: IdSchema,
  agentId: IdSchema,
  status: ResourceRequestStatusSchema,
  createdAt: IsoDateTimeSchema,
});
export type ResourceRequestRecord = z.infer<typeof ResourceRequestRecordSchema>;

export const ResourceRecordSchema = ResourceListingSchema.extend({
  id: IdSchema,
  title: z.string().min(1),
  url: z.string().url().optional(),
  createdAt: IsoDateTimeSchema,
});
export type ResourceRecord = z.infer<typeof ResourceRecordSchema>;

/** Fusion merge result: the requests one purchase satisfies and the node that pays. */
export const PurchaseGroupSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  resourceId: IdSchema,
  payingNodeId: z.number().int().positive(),
  requestIds: z.array(IdSchema).min(1),
  mergeReason: z.string().min(1),
  createdAt: IsoDateTimeSchema,
});
export type PurchaseGroup = z.infer<typeof PurchaseGroupSchema>;

export const AllocationRecordSchema = AllocationSchema.extend({
  id: IdSchema,
  purchaseId: IdSchema,
});
export type AllocationRecord = z.infer<typeof AllocationRecordSchema>;

/** A purchases row: the shared PurchaseOrder plus storage-only fields. */
export const PurchaseRecordSchema = PurchaseOrderSchema.safeExtend({
  idempotencyKey: z.string().min(1),
  purchaseGroupId: IdSchema.optional(),
  /** Oracle's stated decision reason (audit trail). */
  oracleReason: z.string().optional(),
  updatedAt: IsoDateTimeSchema,
});
export type PurchaseRecord = z.infer<typeof PurchaseRecordSchema>;

/** One decoded log from a confirmed transaction. Unique on (txHash, logIndex). */
export const ChainTransactionSchema = z.object({
  id: IdSchema,
  purchaseId: IdSchema.optional(),
  txHash: Bytes32Schema,
  logIndex: z.number().int().min(0),
  blockNumber: UintStringSchema,
  contractAddress: AddressSchema,
  /** Event name as emitted, e.g. "Paid", "OrderFunded", "Refunded". */
  eventName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  observedAt: IsoDateTimeSchema,
  confirmed: z.boolean(),
});
export type ChainTransaction = z.infer<typeof ChainTransactionSchema>;

/** Mirrors OverflowEscrow `enum Status`. */
export const ESCROW_STATUSES = ["Created", "Funded", "Revealed", "Settled", "Refunded"] as const;
export const EscrowStatusSchema = z.enum(ESCROW_STATUSES);
export type EscrowStatus = z.infer<typeof EscrowStatusSchema>;

/** Created → Funded → Revealed → Settled; Refunded from Funded (timeout) or Revealed (proof). */
export const ESCROW_TRANSITIONS: Readonly<Record<EscrowStatus, readonly EscrowStatus[]>> = {
  Created: ["Funded"],
  Funded: ["Revealed", "Refunded"],
  Revealed: ["Settled", "Refunded"],
  Settled: [],
  Refunded: [],
};

export const EscrowOrderSchema = z.object({
  id: IdSchema,
  purchaseId: IdSchema,
  orderIdBytes32: Bytes32Schema,
  escrowAddress: AddressSchema,
  sellerAddress: AddressSchema,
  amountAtomic: AtomicAmountSchema,
  bondAtomic: AtomicAmountSchema,
  termsHash: Bytes32Schema,
  manifestHash: Bytes32Schema,
  rootPlain: Bytes32Schema,
  rootCipher: Bytes32Schema,
  keyCommitment: Bytes32Schema,
  /** Unix seconds. */
  revealDeadline: UintStringSchema,
  /** Seconds. */
  challengeWindow: UintStringSchema,
  sourceKey: AddressSchema,
  /** Unix seconds. */
  minTimestamp: UintStringSchema,
  status: EscrowStatusSchema,
  revealedKey: Bytes32Schema.optional(),
  refundReason: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type EscrowOrder = z.infer<typeof EscrowOrderSchema>;

/**
 * One double-entry row (SPEC "Journal entries"). `sourceEventId` is unique so
 * every chain event books exactly once; corrections are new rows that point at
 * the row they fix. Nothing is deleted.
 */
export const FinancialEntrySchema = z
  .object({
    id: IdSchema,
    purchaseId: IdSchema.optional(),
    debitAccount: LedgerAccountSchema,
    creditAccount: LedgerAccountSchema,
    amountAtomic: AtomicAmountSchema,
    memo: z.string().min(1),
    sourceEventId: z.string().min(1),
    department: z.string().min(1).optional(),
    txHash: Bytes32Schema.optional(),
    correctsEntryId: IdSchema.optional(),
    postedAt: IsoDateTimeSchema,
  })
  .refine((e) => e.debitAccount !== e.creditAccount, {
    message: "debit and credit accounts must differ",
    path: ["creditAccount"],
  });
export type FinancialEntry = z.infer<typeof FinancialEntrySchema>;

export const RESERVATION_STATUSES = ["active", "consumed", "released"] as const;
export const ReservationStatusSchema = z.enum(RESERVATION_STATUSES);

/** Mirror of treasury `reservations[digest]` plus its lifecycle. */
export const ReservationRecordSchema = z.object({
  id: IdSchema,
  digest: Bytes32Schema,
  purchaseId: IdSchema.optional(),
  nodeId: z.number().int().positive(),
  valueAtomic: AtomicAmountSchema,
  /** Unix seconds. */
  validBefore: UintStringSchema,
  nonce: Bytes32Schema,
  status: ReservationStatusSchema,
  txHash: Bytes32Schema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ReservationRecord = z.infer<typeof ReservationRecordSchema>;

export const SampleVerdictSchema = z.enum(["buy", "skip"]);

/** Oracle's judgment of a random chunk sample, with prompt/output hashes for audit. */
export const SampleRecordSchema = z.object({
  id: IdSchema,
  purchaseId: IdSchema,
  indices: z.array(z.number().int().min(0)).min(1),
  verdict: SampleVerdictSchema,
  reason: z.string().min(1),
  /** Model confidence 0..1 (a score, not money). */
  confidence: z.number().min(0).max(1).optional(),
  promptHash: Bytes32Schema.optional(),
  outputHash: Bytes32Schema.optional(),
  createdAt: IsoDateTimeSchema,
});
export type SampleRecord = z.infer<typeof SampleRecordSchema>;

/** Persists across missions (SPEC "Time and memory"). */
export const SellerHistorySchema = z.object({
  sellerAddress: AddressSchema,
  sellerId: IdSchema.optional(),
  orders: z.number().int().min(0),
  onTimeReveals: z.number().int().min(0),
  lateReveals: z.number().int().min(0),
  provenCheats: z.number().int().min(0),
  flagged: z.boolean(),
  updatedAt: IsoDateTimeSchema,
});
export type SellerHistory = z.infer<typeof SellerHistorySchema>;

/** One stored result of an idempotent API call; see the idempotency_keys table. */
export const IdempotencyRecordSchema = z.object({
  key: z.string().min(1).max(200),
  scope: z.string().min(1),
  /** Hash of the canonical request (method, path, body); a cache key, not a signed digest. */
  requestHash: Bytes32Schema,
  statusCode: z.number().int().min(100).max(599),
  response: z.unknown(),
  createdAt: IsoDateTimeSchema,
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;
