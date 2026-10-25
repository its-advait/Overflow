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
// Journal entries (SPEC "Journal entries (immediate-expense policy)")
// ---------------------------------------------------------------------------

export const LedgerAccountSchema = z.enum([
  "usdc-treasury",
  "escrow-deposit",
  "data-expense",
  "owner-contribution",
  "other-income-seller-forfeiture",
]);
export type LedgerAccount = z.infer<typeof LedgerAccountSchema>;

/**
 * Chain events the ledger books against. Exactly one entry per event. `Swept` is the escrow's own event (USDC
 * recovered from a closed order back to the treasury). `LateArrival` is derived by the service from a USDC
 * `Transfer` into an escrow observed after that escrow's terminal event; no contract emits it.
 */
export const ChainEventKindSchema = z.enum([
  "Paid",
  "Reserved",
  "ReservationReleased",
  "OrderFunded",
  "PaidOut",
  "Refunded",
  "Swept",
  "LateArrival",
]);
export type ChainEventKind = z.infer<typeof ChainEventKindSchema>;

export const JournalLineSchema = z
  .object({
    account: LedgerAccountSchema,
    department: z.string().min(1).optional(),
    debitAtomic: AtomicAmountSchema,
    creditAtomic: AtomicAmountSchema,
  })
  .refine((l) => (l.debitAtomic === "0") !== (l.creditAtomic === "0"), {
    message: "a line is either a debit or a credit, not both or neither",
  });
export type JournalLine = z.infer<typeof JournalLineSchema>;

export const JournalEntrySchema = z
  .object({
    id: IdSchema,
    purchaseId: IdSchema.optional(),
    postedAt: IsoDateTimeSchema,
    memo: z.string(),
    lines: z.array(JournalLineSchema).min(2),
    /** Audit links (SPEC "Audit trail"). */
    authorizationDigest: Bytes32Schema.optional(),
    txHash: Bytes32Schema.optional(),
    chainEvent: ChainEventKindSchema.optional(),
    /** Corrections are new entries that point at the one they fix. */
    correctsEntryId: IdSchema.optional(),
  })
  .superRefine((e, ctx) => {
    // Zod 4 still runs this after a line check failed; skip when any amount is malformed.
    const amounts = e.lines.flatMap((l) => [l.debitAtomic, l.creditAtomic]);
    if (!amounts.every((v) => AtomicAmountSchema.safeParse(v).success)) return;
    let debits = 0n;
    let credits = 0n;
    for (const l of e.lines) {
      debits += atomicToBigInt(l.debitAtomic);
      credits += atomicToBigInt(l.creditAtomic);
    }
    if (debits !== credits) {
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: `debits ${debits} != credits ${credits}`,
      });
    }
  });
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

export const ActivityKindSchema = z.enum([
  "mission.created",
  "purchase.proposed",
  "purchase.status",
  "payment.authorized",
  "escrow.funded",
  "escrow.settled",
  "escrow.refunded",
  "policy.blocked",
  "controller.requested",
  "controller.resolved",
  "exception.opened",
  "reconciliation.ok",
]);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export const ActivityEventSchema = z.object({
  id: IdSchema,
  at: IsoDateTimeSchema,
  kind: ActivityKindSchema,
  message: z.string(),
  purchaseId: IdSchema.optional(),
  missionId: IdSchema.optional(),
  agentId: IdSchema.optional(),
  /** Decoded treasury revert for the Blocked lane, e.g. "OverBudget(3)". */
  decodedRevert: z.string().optional(),
  txHash: Bytes32Schema.optional(),
  /** True when the event came from a simulated seller, dataset or attacker. */
  simulated: z.boolean().default(false),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

// ---------------------------------------------------------------------------
// Exceptions (SPEC "When it asks a human")
// ---------------------------------------------------------------------------

export const ExceptionTypeSchema = z.enum([
  "reconciliation-difference",
  "new-payee",
  "budget-raise",
  "unclear-license",
  "low-confidence-sample",
  "dispute",
]);
export type ExceptionType = z.infer<typeof ExceptionTypeSchema>;

export const ExceptionStatusSchema = z.enum(["open", "resolved", "dismissed"]);

export const ExceptionRecordSchema = z.object({
  id: IdSchema,
  type: ExceptionTypeSchema,
  reason: z.string().min(1),
  amountAtomic: AtomicAmountSchema.optional(),
  status: ExceptionStatusSchema,
  openedAt: IsoDateTimeSchema,
  purchaseId: IdSchema.optional(),
  resolvedBy: z.string().min(1).optional(),
  resolvedAt: IsoDateTimeSchema.optional(),
});
export type ExceptionRecord = z.infer<typeof ExceptionRecordSchema>;

// ---------------------------------------------------------------------------
// Controller requests: owner actions a human approves in Coinbase Wallet.
// The schema describes the request; it never executes anything.
// ---------------------------------------------------------------------------

export const ControllerActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set-allow"), payee: AddressSchema, allowed: z.boolean() }),
  z.object({
    kind: z.literal("raise-cap"),
    nodeId: z.number().int().positive(),
    newCapAtomic: AtomicAmountSchema,
  }),
  z.object({ kind: z.literal("pause"), nodeId: z.number().int().positive() }),
  z.object({ kind: z.literal("unpause"), nodeId: z.number().int().positive() }),
  z.object({ kind: z.literal("set-floor"), newFloorAtomic: AtomicAmountSchema }),
  z.object({ kind: z.literal("withdraw"), to: AddressSchema, amountAtomic: AtomicAmountSchema }),
  z.object({ kind: z.literal("set-escrow-factory"), factory: AddressSchema }),
]);
export type ControllerAction = z.infer<typeof ControllerActionSchema>;

export const ControllerRequestStatusSchema = z.enum(["pending", "approved", "rejected", "executed"]);

export const ControllerRequestSchema = z.object({
  id: IdSchema,
  action: ControllerActionSchema,
  requestedBy: IdSchema,
  reason: z.string().min(1),
  status: ControllerRequestStatusSchema,
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.optional(),
  /** Set only after the owner transaction is confirmed onchain. */
  txHash: Bytes32Schema.optional(),
});
export type ControllerRequest = z.infer<typeof ControllerRequestSchema>;
