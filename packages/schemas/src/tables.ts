import { z } from "zod";
import { EscrowStatusSchema, LedgerAccountSchema, type EscrowStatus } from "./ledger";
import { MissionSchema } from "./mission";
import {
  AddressSchema,
  AtomicAmountSchema,
  Bytes32Schema,
  HexSchema,
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

/**
 * Mirrors OverflowEscrow `enum Status`: Created → Funded → Revealed → Settled; Refunded from Created or Funded
 * (claimTimeoutRefund accepts both once revealDeadline passed) and from Revealed (a proven complaint).
 */
export const ESCROW_TRANSITIONS: Readonly<Record<EscrowStatus, readonly EscrowStatus[]>> = {
  Created: ["Funded", "Refunded"],
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
  /** Number of 160-byte records (OrderTerms.chunkCount, uint32); pins every Merkle proof length. */
  chunkCount: z.number().int().min(1).max(4_294_967_295).default(1),
  status: EscrowStatusSchema,
  revealedKey: Bytes32Schema.optional(),
  /** Unix seconds; set by the indexed KeyRevealed (reveal time + challengeWindow). */
  challengeEnd: UintStringSchema.optional(),
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
    /** Chain event this row books: "<txHash>:<logIndex>". Department lines of one event share it. */
    eventKey: z.string().min(1),
    /** Unique per row: the eventKey, or "<eventKey>#<department>" for one line of a department split. */
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
export type SampleVerdict = z.infer<typeof SampleVerdictSchema>;

/** Outcome of recourse-crypto's verifySample for one sampled chunk. */
export const SampleRowVerifiedSchema = z.enum(["ok", "cipher-proof", "plain-proof", "decrypt-mismatch"]);

/**
 * One sampled chunk as the buyer saw it before funding: the ciphertext and both Merkle proofs the seller served,
 * the chunk key the seller revealed, and the decrypted record. Everything a reader needs to re-verify in a browser.
 */
export const SampleRowSchema = z.object({
  index: z.number().int().min(0),
  /** Record timestamp (uint64, unix seconds) decoded from the plaintext payload; absent when decryption failed. */
  timestamp: UintStringSchema.optional(),
  /** The decoded CSV row text; absent when decryption failed. */
  row: z.string().optional(),
  cipherChunk: HexSchema,
  chunkKey: Bytes32Schema,
  plainLeaf: Bytes32Schema,
  plainChunk: HexSchema.optional(),
  cipherProof: z.array(Bytes32Schema),
  plainProof: z.array(Bytes32Schema),
  verified: SampleRowVerifiedSchema,
});
export type SampleRow = z.infer<typeof SampleRowSchema>;

/** The buyer's judgment of a random chunk sample, with the evidence and (for a model judge) prompt/output hashes. */
export const SampleRecordSchema = z.object({
  id: IdSchema,
  purchaseId: IdSchema,
  indices: z.array(z.number().int().min(0)).min(1),
  /** The bytes pickSampleIndices drew from; lets a reader re-derive `indices`. */
  randomness: Bytes32Schema.optional(),
  verdict: SampleVerdictSchema,
  reason: z.string().min(1),
  /** Who judged: a model id, or a labelled rule such as "rule:recourse-sample-v1 (SIMULATED, no model)". */
  judge: z.string().min(1).default("unspecified"),
  rows: z.array(SampleRowSchema).default([]),
  /** Model confidence 0..1 (a score, not money). */
  confidence: z.number().min(0).max(1).optional(),
  promptHash: Bytes32Schema.optional(),
  outputHash: Bytes32Schema.optional(),
  /** True when the seller, dataset or judge is simulated. */
  simulated: z.boolean().default(false),
  createdAt: IsoDateTimeSchema,
});
export type SampleRecord = z.infer<typeof SampleRecordSchema>;

export const COMPLAINT_KINDS = ["mismatch", "promise"] as const;
export const ComplaintKindSchema = z.enum(COMPLAINT_KINDS);
export type ComplaintKind = z.infer<typeof ComplaintKindSchema>;
export const COMPLAINT_STATUSES = ["built", "submitted", "proven", "rejected"] as const;
export const ComplaintStatusSchema = z.enum(COMPLAINT_STATUSES);
export type ComplaintStatus = z.infer<typeof ComplaintStatusSchema>;

/**
 * A complaint the buyer built after the key reveal: exactly the calldata of complainMismatch / complainPromise,
 * the checks the buyer ran before sending it, and what the chain said. `proven` is set only by the indexed
 * CheatProven event. An allegation alone never refunds.
 */
export const ComplaintRecordSchema = z.object({
  id: IdSchema,
  purchaseId: IdSchema,
  escrowAddress: AddressSchema,
  kind: ComplaintKindSchema,
  chunkIndex: z.number().int().min(0),
  /** complainMismatch: the ciphertext chunk; complainPromise: the plaintext record. */
  chunk: HexSchema,
  cipherProof: z.array(Bytes32Schema).default([]),
  /** The committed plain leaf (mismatch) or the record's leaf (promise). */
  plainLeaf: Bytes32Schema,
  plainProof: z.array(Bytes32Schema),
  /** keccak256(decrypt(chunk, k_i)) the buyer derived; mismatch only. */
  derivedLeaf: Bytes32Schema.optional(),
  revealedKey: Bytes32Schema.optional(),
  /** The decrypted row text, when it decodes (mismatch only). */
  decryptedRow: z.string().optional(),
  cipherProofVerified: z.boolean(),
  plainProofVerified: z.boolean(),
  /** The cheat the complaint alleges, as the buyer recomputed it (leaf differs / promise broken). */
  cheatVerified: z.boolean(),
  detail: z.string().min(1),
  status: ComplaintStatusSchema,
  txHash: Bytes32Schema.optional(),
  simulated: z.boolean().default(false),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ComplaintRecord = z.infer<typeof ComplaintRecordSchema>;

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

/** One indexer checkpoint row (indexer_cursors). `lastBlock` is a decimal block number. */
export const IndexerCursorSchema = z.object({
  name: z.string().min(1),
  lastBlock: UintStringSchema,
  updatedAt: IsoDateTimeSchema,
});
export type IndexerCursor = z.infer<typeof IndexerCursorSchema>;
