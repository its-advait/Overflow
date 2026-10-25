import { z } from "zod";
import { atomicToBigInt } from "./money";
import {
  AddressSchema,
  AtomicAmountSchema,
  Bytes32Schema,
  IdSchema,
  IsoDateTimeSchema,
} from "./primitives";

// ---------------------------------------------------------------------------
// Purchase state machine (docs/SPEC.md "Purchase state machine")
//
// Happy path:
//   PROPOSED → RESERVED → PAYMENT_PENDING → ESCROW_FUNDED → DELIVERY_PENDING → SETTLED | REFUNDED
//
// Side exits:
//   REJECTED              a treasury policy revert; no funds moved
//   PAYMENT_UNKNOWN       broadcast with no receipt yet; resolve by reconciling, never by a new nonce
//   FAILED_BEFORE_FUNDING any other failure before USDC moved
//   RELEASED              a reservation expired unused (release() restored allowance)
//
// Authorization (RESERVED/PAYMENT_PENDING), escrow funding (ESCROW_FUNDED) and
// final settlement (SETTLED/REFUNDED) are distinct states on purpose.
// ---------------------------------------------------------------------------

export const PURCHASE_STATUSES = [
  "PROPOSED",
  "RESERVED",
  "PAYMENT_PENDING",
  "ESCROW_FUNDED",
  "DELIVERY_PENDING",
  "SETTLED",
  "REFUNDED",
  "REJECTED",
  "PAYMENT_UNKNOWN",
  "FAILED_BEFORE_FUNDING",
  "RELEASED",
] as const;

export const PurchaseStatusSchema = z.enum(PURCHASE_STATUSES);
export type PurchaseStatus = z.infer<typeof PurchaseStatusSchema>;

export const ALLOWED_TRANSITIONS: Readonly<Record<PurchaseStatus, readonly PurchaseStatus[]>> = {
  PROPOSED: ["RESERVED", "REJECTED", "FAILED_BEFORE_FUNDING"],
  RESERVED: ["PAYMENT_PENDING", "RELEASED", "REJECTED", "FAILED_BEFORE_FUNDING"],
  PAYMENT_PENDING: ["ESCROW_FUNDED", "PAYMENT_UNKNOWN", "REJECTED", "FAILED_BEFORE_FUNDING"],
  // Only reconciliation against the chain may leave PAYMENT_UNKNOWN.
  PAYMENT_UNKNOWN: ["ESCROW_FUNDED", "FAILED_BEFORE_FUNDING"],
  ESCROW_FUNDED: ["DELIVERY_PENDING", "REFUNDED"],
  DELIVERY_PENDING: ["SETTLED", "REFUNDED"],
  // Terminal states.
  SETTLED: [],
  REFUNDED: [],
  REJECTED: [],
  FAILED_BEFORE_FUNDING: [],
  RELEASED: [],
};

export const TERMINAL_STATUSES: readonly PurchaseStatus[] = PURCHASE_STATUSES.filter(
  (s) => ALLOWED_TRANSITIONS[s].length === 0,
);

export function isTerminalStatus(status: PurchaseStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: PurchaseStatus,
    public readonly to: PurchaseStatus,
  ) {
    super(`invalid purchase transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Pure check: is `from -> to` in the allowed-transitions table? */
export function canTransition(from: PurchaseStatus, to: PurchaseStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Pure assertion: returns `to`, or throws InvalidTransitionError. */
export function assertTransition(from: PurchaseStatus, to: PurchaseStatus): PurchaseStatus {
  PurchaseStatusSchema.parse(from);
  PurchaseStatusSchema.parse(to);
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

// ---------------------------------------------------------------------------
// PurchaseOrder (docs/SPEC.md "Shared offchain type")
// ---------------------------------------------------------------------------

export const PaymentPathSchema = z.enum(["overflow-facilitator", "coinbase-facilitator"]);
export type PaymentPath = z.infer<typeof PaymentPathSchema>;

/** Fusion subledger share of one purchase. Does not touch any onchain cap. */
export const AllocationSchema = z.object({
  agentId: IdSchema,
  department: z.string().min(1),
  amountAtomic: AtomicAmountSchema,
});
export type Allocation = z.infer<typeof AllocationSchema>;

export const PurchaseOrderSchema = z
  .object({
    id: IdSchema,
    orderIdBytes32: Bytes32Schema,
    missionId: IdSchema,
    resourceId: IdSchema,
    buyerTreasury: AddressSchema,
    sellerAddress: AddressSchema,
    escrowAddress: AddressSchema,
    chainId: z.literal(84532),
    tokenAddress: AddressSchema,
    amountAtomic: AtomicAmountSchema,
    payingNodeId: z.number().int().positive(),
    participatingAgentIds: z.array(IdSchema),
    allocations: z.array(AllocationSchema),
    resourceManifestHash: Bytes32Schema,
    termsHash: Bytes32Schema,
    paymentPath: PaymentPathSchema,
    authorizationDigest: Bytes32Schema.optional(),
    txHashes: z.array(Bytes32Schema),
    createdAt: IsoDateTimeSchema,
    authorizationExpiresAt: IsoDateTimeSchema,
    status: PurchaseStatusSchema,
  })
  .superRefine((order, ctx) => {
    if (order.allocations.length === 0) return;
    // Zod 4 still runs this after a field check failed; skip when any amount is malformed.
    const amounts = [order.amountAtomic, ...order.allocations.map((a) => a.amountAtomic)];
    if (!amounts.every((v) => AtomicAmountSchema.safeParse(v).success)) return;
    let sum = 0n;
    for (const a of order.allocations) sum += atomicToBigInt(a.amountAtomic);
    if (sum !== atomicToBigInt(order.amountAtomic)) {
      ctx.addIssue({
        code: "custom",
        path: ["allocations"],
        message: `allocations sum to ${sum} but amountAtomic is ${order.amountAtomic}`,
      });
    }
  });
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;

// ---------------------------------------------------------------------------
// PaymentStatus: what Oracle, Fusion and the UI see from a PaymentAdapter
// (SPEC "One payment interface, two paths"). Never says which path ran beyond `path`.
// ---------------------------------------------------------------------------

export const PaymentStatusSchema = z.object({
  purchaseId: IdSchema,
  path: PaymentPathSchema,
  status: PurchaseStatusSchema,
  /** EIP-712 digest of the one authorization this purchase may ever have. */
  authorizationDigest: Bytes32Schema.optional(),
  nonce: Bytes32Schema.optional(),
  txHash: Bytes32Schema.optional(),
  explorerUrl: z.string().optional(),
  /** USDC's authorizationState(treasury, nonce) at `checkedAt`, when it was read. */
  authorizationUsed: z.boolean().optional(),
  reason: z.string().optional(),
  /** Decoded treasury revert for the Blocked lane, e.g. "PayeeNotAllowed(0)". */
  decodedRevert: z.string().optional(),
  checkedAt: IsoDateTimeSchema,
});
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
