import { z } from "zod";
import { atomicToBigInt } from "./money";
import {
  AddressSchema,
  AtomicAmountSchema,
  Bytes32Schema,
  HexSchema,
  IdSchema,
  IsoDateTimeSchema,
  UintStringSchema,
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
  "BondForfeited",
  /** USDC ERC-20 Transfer into or out of the treasury (funding, direct x402 purchase). */
  "Transfer",
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
  // The owner edited one extracted requirement / confirmed the requirements. Nothing bought.
  "mission.requirement_edited",
  "mission.confirmed",
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
  // Chain indexer kinds: one per confirmed log that does not itself move a purchase.
  "treasury.paid",
  "treasury.reserved",
  "treasury.released",
  "treasury.node",
  "treasury.policy",
  "escrow.created",
  "escrow.revealed",
  "escrow.accepted",
  "seller.flagged",
  "indexer.unconfirmed",
  // USDC transfers touching the treasury; the ledger books funding and direct purchases from these.
  "usdc.transfer",
  "escrow.bond-forfeited",
  // Reconciliation run that found at least one difference (each also opens an exception).
  "reconciliation.difference",
  // Oracle audit: one per model call, carrying the prompt hash and output hash (SPEC "Oracle" guardrails).
  "oracle.model_call",
  // Oracle decision per resource request: chosen listing, rejections and summary. It authorizes no payment.
  "oracle.recommendation",
  // Fusion decision per candidate group: merge or not, the failing rule, the paying node. It authorizes no payment.
  "fusion.decision",
  // Orchestration: one event per sub-agent tool call and per tool result (agentId set), the agent's final
  // report, the orchestrator's signed CreateChild/PauseChild and its relay receipt, and mission run start/finish.
  // None of these move money; payments show up only as treasury.* / policy.blocked events.
  "agent.tool_call",
  "agent.tool_result",
  "agent.report",
  "delegation.signed",
  "delegation.relayed",
  "mission.run",
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

/**
 * Every case where Overflow must ask a human. The first three need an owner
 * transaction (setAllow, raiseCap, pause) and carry a prepared ControllerRequest;
 * the others are decided offchain by the controller.
 */
export const EXCEPTION_TYPES = [
  "NEW_PAYEE",
  "CAP_RAISE",
  "PAUSE_REQUEST",
  "UNCLEAR_LICENSE",
  "LOW_CONFIDENCE_SAMPLE",
  "RECONCILIATION_DIFF",
  "DISPUTE_WITHOUT_PROOF",
] as const;
export const ExceptionTypeSchema = z.enum(EXCEPTION_TYPES);
export type ExceptionType = z.infer<typeof ExceptionTypeSchema>;

/** Exception types whose resolution is a treasury owner call confirmed onchain. */
export const ONCHAIN_EXCEPTION_TYPES = ["NEW_PAYEE", "CAP_RAISE", "PAUSE_REQUEST"] as const satisfies readonly ExceptionType[];
export type OnchainExceptionType = (typeof ONCHAIN_EXCEPTION_TYPES)[number];
export const isOnchainExceptionType = (t: ExceptionType): t is OnchainExceptionType =>
  (ONCHAIN_EXCEPTION_TYPES as readonly string[]).includes(t);

export const ExceptionStatusSchema = z.enum(["open", "resolved", "dismissed"]);
export type ExceptionStatus = z.infer<typeof ExceptionStatusSchema>;

/** The controller's call on an exception. Onchain types are only ever approved by the indexed event. */
export const ExceptionDecisionSchema = z.enum(["approve", "reject"]);
export type ExceptionDecision = z.infer<typeof ExceptionDecisionSchema>;

export const ExceptionRecordSchema = z.object({
  id: IdSchema,
  type: ExceptionTypeSchema,
  reason: z.string().min(1),
  amountAtomic: AtomicAmountSchema.optional(),
  status: ExceptionStatusSchema,
  openedAt: IsoDateTimeSchema,
  purchaseId: IdSchema.optional(),
  /** What the exception is about, e.g. "treasury", "escrow:<purchaseId>", "payee:<address>". One open exception per subject. */
  subject: z.string().min(1).optional(),
  /** Who raised it: an agent id, the session principal, or "system:reconciliation". May never equal the decider. */
  requestedBy: z.string().min(1).optional(),
  /** Typed per-type payload (payee, nodeId + newCapAtomic, resourceId + license, sampleId + confidence, ...). */
  details: z.record(z.string(), z.unknown()).optional(),
  resolvedBy: z.string().min(1).optional(),
  resolvedAt: IsoDateTimeSchema.optional(),
  decision: ExceptionDecisionSchema.optional(),
  /** The controller's stated why (or the confirming chain event for onchain types). */
  decisionReason: z.string().min(1).optional(),
});
export type ExceptionRecord = z.infer<typeof ExceptionRecordSchema>;

// ---------------------------------------------------------------------------
// Reconciliation (SPEC "Reconciliation"): the chain is the bank, the ledger is
// the books. A run compares them at one block and records every difference.
// ---------------------------------------------------------------------------

/** Signed integer atomic amount (chain minus ledger). */
export const SignedAtomicSchema = z.string().regex(/^-?(0|[1-9]\d*)$/, "signed integer atomic units");

/** Default materiality: 0.01 USDC. */
export const DEFAULT_MATERIALITY_ATOMIC = "10000" as const;

export const ReconciliationDifferenceSchema = z.object({
  kind: z.enum(["treasury", "escrow", "event-coverage"]),
  subject: z.string().min(1),
  reason: z.string().min(1),
  chainAtomic: AtomicAmountSchema.optional(),
  ledgerAtomic: SignedAtomicSchema.optional(),
  /** chain - ledger; for event-coverage the amount the event moved. */
  differenceAtomic: SignedAtomicSchema,
  purchaseId: IdSchema.optional(),
  eventKey: z.string().min(1).optional(),
  /** True when |difference| is above materiality (or the check has no amount to compare), so an exception was opened or already open. */
  material: z.boolean(),
});
export type ReconciliationDifference = z.infer<typeof ReconciliationDifferenceSchema>;

export const ReconciliationTriggerSchema = z.enum(["indexer", "api", "test"]);
export type ReconciliationTrigger = z.infer<typeof ReconciliationTriggerSchema>;

/** Escrow order states (the contract's). Defined here so the reconciliation check can name them without a cycle through tables.ts. */
export const ESCROW_STATUSES = ["Created", "Funded", "Revealed", "Settled", "Refunded"] as const;
export const EscrowStatusSchema = z.enum(ESCROW_STATUSES);
export type EscrowStatus = z.infer<typeof EscrowStatusSchema>;

/**
 * One escrow order compared against its escrow-deposit line, recorded for every
 * order a run looked at (matched or not), so the controller sees chain vs ledger
 * for each open escrow rather than only the differences.
 */
export const ReconciliationEscrowCheckSchema = z.object({
  purchaseId: IdSchema,
  escrowAddress: AddressSchema,
  status: EscrowStatusSchema,
  /** Created, Funded or Revealed: the order can still hold the treasury's USDC. */
  open: z.boolean(),
  /** USDC balanceOf(escrow) at the run's block; read only for Funded/Revealed orders. */
  chainAtomic: AtomicAmountSchema.optional(),
  bondAtomic: AtomicAmountSchema,
  /** What the chain says the escrow holds for the treasury (balance minus bond), or 0 for Created and closed orders. */
  expectedAtomic: SignedAtomicSchema,
  /** The order's net escrow-deposit line in the books. */
  ledgerAtomic: SignedAtomicSchema,
  /** expected - ledger. */
  differenceAtomic: SignedAtomicSchema,
  material: z.boolean(),
});
export type ReconciliationEscrowCheck = z.infer<typeof ReconciliationEscrowCheckSchema>;

export const ReconciliationRunSchema = z.object({
  id: IdSchema,
  ranAt: IsoDateTimeSchema,
  trigger: ReconciliationTriggerSchema,
  /** Block the chain balances were read at (the indexer cursor). */
  blockNumber: UintStringSchema,
  treasuryChainAtomic: AtomicAmountSchema,
  treasuryLedgerAtomic: SignedAtomicSchema,
  treasuryDifferenceAtomic: SignedAtomicSchema,
  escrowsChecked: z.number().int().min(0),
  eventsChecked: z.number().int().min(0),
  /** Every escrow order the run compared, matched or not (runs stored before this field existed have none). */
  escrows: z.array(ReconciliationEscrowCheckSchema).default([]),
  /** The materiality threshold this run applied. */
  materialityAtomic: AtomicAmountSchema.default(DEFAULT_MATERIALITY_ATOMIC),
  differences: z.array(ReconciliationDifferenceSchema),
  /** Exceptions opened by this run (ids). Already-open subjects are not reopened. */
  exceptionIds: z.array(IdSchema),
  status: z.enum(["ok", "differences"]),
});
export type ReconciliationRun = z.infer<typeof ReconciliationRunSchema>;

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

/** `done` is set only by the indexer when the matching treasury event is stored; `rejected` by the controller. */
export const ControllerRequestStatusSchema = z.enum(["pending", "done", "rejected"]);
export type ControllerRequestStatus = z.infer<typeof ControllerRequestStatusSchema>;

export const ControllerRequestSchema = z.object({
  id: IdSchema,
  action: ControllerActionSchema,
  /** The exception this request resolves. */
  exceptionId: IdSchema.optional(),
  requestedBy: IdSchema,
  reason: z.string().min(1),
  /** The prepared owner call for Coinbase Wallet `send_calls`: the treasury, its ABI-encoded calldata, no ETH. */
  target: AddressSchema,
  data: HexSchema,
  value: AtomicAmountSchema,
  /** One human-readable line describing exactly what `data` does. */
  summary: z.string().min(1),
  status: ControllerRequestStatusSchema,
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.optional(),
  /** Set only after the owner transaction is confirmed onchain. */
  txHash: Bytes32Schema.optional(),
});
export type ControllerRequest = z.infer<typeof ControllerRequestSchema>;
