import { MergeDecisionSchema } from "@overflow/fusion";
import {
  ActivityEventSchema,
  AddressSchema,
  AgentRecordSchema,
  AtomicAmountSchema,
  Bytes32Schema,
  ChainTransactionSchema,
  ControllerRequestSchema,
  ControllerRequestStatusSchema,
  EscrowOrderSchema,
  ExceptionDecisionSchema,
  ExceptionRecordSchema,
  ExceptionStatusSchema,
  FinancialEntrySchema,
  IdSchema,
  IsoDateTimeSchema,
  LedgerAccountSchema,
  MissionRecordSchema,
  PurchaseGroupSchema,
  NodePaymentsResponseSchema,
  PurchaseRecordSchema,
  ReconciliationRunSchema,
  ResourceRecordSchema,
  ResourceRequestRecordSchema,
  SignedAtomicSchema,
  TreasuryNodesResponseSchema,
  type AgentRecord,
} from "@overflow/schemas";
import { z } from "zod";

// ---------------------------------------------------------------------------
// HTTP contracts for apps/service (docs/SPEC.md "API"). Record shapes come from
// @overflow/schemas. Four schemas have no shared home yet and are mirrored here
// with their service source named; keep them in step:
//   OracleDecisionSchema, PayerSchema, FusionOutcomeSchema
//     -> apps/service/src/orchestration/oracle-port.ts
//   SubmissionSchema -> apps/service/src/api/routes/purchases.ts
//   IndexerStatusSchema -> apps/service/src/chain/bus.ts
// Every response is parsed with its schema before the UI sees it.
// ---------------------------------------------------------------------------

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

// GET /
export const IndexerStatusSchema = z.object({
  state: z.enum(["idle", "starting", "indexing", "stopped"]),
  reason: z.string().optional(),
  chainId: z.number().int().optional(),
  treasury: z.string().optional(),
  escrowFactory: z.string().optional(),
  cursor: z.string().optional(),
  head: z.string().optional(),
  lagBlocks: z.string().optional(),
  trackedEscrows: z.number().int().min(0).optional(),
  lastPollAt: z.string().optional(),
  lastError: z.string().optional(),
  logsIndexed: z.number().int().min(0).optional(),
});
export type IndexerStatus = z.infer<typeof IndexerStatusSchema>;

export const ServiceStatusSchema = z
  .object({
    service: z.string(),
    scaffold: z.boolean(),
    chainId: z.number().int(),
    session: z.object({ organizationId: z.string(), principal: z.string() }),
    indexer: IndexerStatusSchema,
  })
  .loose();
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

// Missions
export const CreateMissionBodySchema = z.object({
  goal: z.string().min(1).max(2000),
  /** Integer atomic USDC; convert with toAtomic(), never a float. */
  budgetAtomic: AtomicAmountSchema,
  rootNodeId: z.number().int().positive().optional(),
  ownerAgentId: IdSchema.optional(),
});
export type CreateMissionBody = z.infer<typeof CreateMissionBodySchema>;
export const MissionResponseSchema = z.object({ mission: MissionRecordSchema });
export type MissionResponse = z.infer<typeof MissionResponseSchema>;
// GET /api/missions and GET /api/missions/:id (apps/service/src/api/routes/missions.ts). Oracle decisions and
// Fusion rule checks are not stored; they only come back from POST /api/purchases/propose.
export const MissionsResponseSchema = z.object({ missions: z.array(MissionRecordSchema) });
export type MissionsResponse = z.infer<typeof MissionsResponseSchema>;
export const MissionDetailResponseSchema = z.object({
  mission: MissionRecordSchema,
  requests: z.array(ResourceRequestRecordSchema),
  purchases: z.array(PurchaseRecordSchema),
  groups: z.array(PurchaseGroupSchema),
});
export type MissionDetailResponse = z.infer<typeof MissionDetailResponseSchema>;
export const PlanResponseSchema = z.object({
  mission: MissionRecordSchema,
  requests: z.array(ResourceRequestRecordSchema),
});
export type PlanResponse = z.infer<typeof PlanResponseSchema>;
export const RunMissionBodySchema = z.object({ forceInjectionBeat: z.boolean().optional() });
export type RunMissionBody = z.infer<typeof RunMissionBodySchema>;
export const RunMissionResponseSchema = z.object({
  mission: MissionRecordSchema,
  runId: IdSchema,
  note: z.string(),
});
export type RunMissionResponse = z.infer<typeof RunMissionResponseSchema>;
export const PauseMissionAgentResponseSchema = z.object({
  txHash: z.string(),
  nodeId: z.number().int(),
  agentId: IdSchema,
});
export type PauseMissionAgentResponse = z.infer<typeof PauseMissionAgentResponseSchema>;

// Resources
export const ResourcesResponseSchema = z.object({
  resources: z.array(ResourceRecordSchema),
  filtered: z.boolean(),
  missionId: IdSchema.optional(),
});
export type ResourcesResponse = z.infer<typeof ResourcesResponseSchema>;

// Purchases
export const OracleDecisionSchema = z.object({
  requestId: IdSchema,
  chosen: IdSchema.nullable(),
  alternatives: z.array(IdSchema),
  rejected: z.array(
    z.object({
      listingId: IdSchema,
      reasons: z.array(z.object({ reason: z.string().min(1), detail: z.string().min(1) })),
    }),
  ),
  assumptions: z.array(z.string()),
  /** Ends with "This is a recommendation; it authorizes no payment." */
  summary: z.string().min(1),
  simulated: z.boolean(),
});
export type OracleDecision = z.infer<typeof OracleDecisionSchema>;

export const PayerSchema = z.object({
  agentId: IdSchema.nullable(),
  nodeId: z.number().int().positive(),
  rule: z.enum(["lca", "lca-ancestor-with-node", "mission-root"]),
  evidence: z.string().min(1),
});
export type Payer = z.infer<typeof PayerSchema>;

export const FusionOutcomeSchema = MergeDecisionSchema.extend({
  payer: PayerSchema.nullable(),
  waitingRequestIds: z.array(IdSchema),
});
export type FusionOutcome = z.infer<typeof FusionOutcomeSchema>;

export const ProposeBodySchema = z.object({ missionId: IdSchema });
export type ProposeBody = z.infer<typeof ProposeBodySchema>;
export const ProposeResponseSchema = z.object({
  purchases: z.array(PurchaseRecordSchema),
  decisions: z.array(OracleDecisionSchema),
  merges: z.array(FusionOutcomeSchema),
});
export type ProposeResponse = z.infer<typeof ProposeResponseSchema>;

export const AuthorizeBodySchema = z.object({ note: z.string().max(500).optional() });
export type AuthorizeBody = z.infer<typeof AuthorizeBodySchema>;
export const SubmissionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("submitted"), txHash: Bytes32Schema }),
  z.object({ outcome: z.literal("rejected"), decodedRevert: z.string() }),
  z.object({ outcome: z.literal("unknown"), error: z.string() }),
]);
export type Submission = z.infer<typeof SubmissionSchema>;
export const AuthorizeResponseSchema = z.object({
  purchase: PurchaseRecordSchema,
  authorizationDigest: Bytes32Schema,
  /** What the adapter reported. Funding is only ever set from a confirmed chain event. */
  submission: SubmissionSchema,
  replayed: z.boolean(),
});
export type AuthorizeResponse = z.infer<typeof AuthorizeResponseSchema>;

export const PurchaseResponseSchema = z.object({
  purchase: PurchaseRecordSchema,
  escrow: EscrowOrderSchema.nullable(),
  chainTransactions: z.array(ChainTransactionSchema),
  activity: z.array(ActivityEventSchema),
});
export type PurchaseResponse = z.infer<typeof PurchaseResponseSchema>;

// Escrow (apps/service/src/api/routes/escrow.ts): the list and the detail read model from @overflow/schemas.
// `chain` and `actions` are null when the service has no chain reader; the page then renders the stored evidence
// and judges the gates locally, saying so.
export { EscrowDetailResponseSchema as EscrowResponseSchema, EscrowListResponseSchema } from "@overflow/schemas";
export type { ActionGate, EscrowAction, EscrowActions, EscrowChainState, EscrowDetailResponse as EscrowResponse, EscrowListResponse, EscrowSummary } from "@overflow/schemas";

// Agents
export type AgentTreeNode = AgentRecord & { node: null; children: AgentTreeNode[] };
export const AgentTreeNodeSchema: z.ZodType<AgentTreeNode> = AgentRecordSchema.extend({
  /** Onchain node state is never fabricated: null until the chain module reads the treasury. */
  node: z.null(),
  children: z.lazy(() => z.array(AgentTreeNodeSchema)),
}) as z.ZodType<AgentTreeNode>;
export const AgentsResponseSchema = z.object({
  agents: z.array(AgentRecordSchema),
  tree: z.array(AgentTreeNodeSchema),
});
export type AgentsResponse = z.infer<typeof AgentsResponseSchema>;
export const PauseAgentBodySchema = z.object({ reason: z.string().min(1).max(500) });
export type PauseAgentBody = z.infer<typeof PauseAgentBodySchema>;
export const PauseAgentResponseSchema = z.object({
  exception: ExceptionRecordSchema,
  request: ControllerRequestSchema,
});
export type PauseAgentResponse = z.infer<typeof PauseAgentResponseSchema>;

// Treasury nodes (the delegation tree read from the chain) and one node's Paid logs
export { NodePaymentsResponseSchema, TreasuryNodesResponseSchema };
export type { NodePayment, NodePaymentsResponse, NodeStatus, TreasuryNodesResponse, TreasuryNodeView } from "@overflow/schemas";

// Activity
export const ActivityQuerySchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  purchaseId: IdSchema.optional(),
  missionId: IdSchema.optional(),
  agentId: IdSchema.optional(),
});
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;
export const ActivityResponseSchema = z.object({ events: z.array(ActivityEventSchema) });
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;

// Exceptions and controller requests
export const ExceptionsQuerySchema = z.object({
  status: ExceptionStatusSchema.or(z.literal("all")).optional(),
});
export type ExceptionsQuery = z.infer<typeof ExceptionsQuerySchema>;
export const ExceptionWithRequestSchema = ExceptionRecordSchema.extend({
  request: ControllerRequestSchema.nullable(),
});
export type ExceptionWithRequest = z.infer<typeof ExceptionWithRequestSchema>;
export const ExceptionsResponseSchema = z.object({ exceptions: z.array(ExceptionWithRequestSchema) });
export type ExceptionsResponse = z.infer<typeof ExceptionsResponseSchema>;
export const DecideExceptionBodySchema = z.object({
  decidedBy: z.string().min(1),
  decision: ExceptionDecisionSchema,
  reason: z.string().min(1).max(2000),
});
export type DecideExceptionBody = z.infer<typeof DecideExceptionBodySchema>;
export const DecideExceptionResponseSchema = z.object({
  exception: ExceptionRecordSchema,
  request: ControllerRequestSchema.nullable(),
});
export type DecideExceptionResponse = z.infer<typeof DecideExceptionResponseSchema>;
/**
 * POST /api/exceptions, the three onchain kinds the agent menu raises. Each opens an exception
 * with a prepared owner call; the service answers 202 `created: true`, or 200 `created: false`
 * with the request that is already open for the same subject. NEW_PAYEE is the treasury's
 * GLOBAL allowlist (setAllow): per-node payees are fixed when a child is created.
 */
const RaiseCommon = {
  requestedBy: z.string().min(1),
  reason: z.string().min(1).max(2000),
  agentId: IdSchema.optional(),
};
export const RaiseExceptionBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PAUSE_REQUEST"), ...RaiseCommon, nodeId: z.number().int().positive() }),
  z.object({ type: z.literal("CAP_RAISE"), ...RaiseCommon, nodeId: z.number().int().positive(), newCapAtomic: AtomicAmountSchema }),
  z.object({ type: z.literal("NEW_PAYEE"), ...RaiseCommon, payee: AddressSchema }),
]);
export type RaiseExceptionBody = z.infer<typeof RaiseExceptionBodySchema>;
export const RaiseExceptionResponseSchema = z.object({
  exception: ExceptionRecordSchema,
  request: ControllerRequestSchema.nullable(),
  /** False when an open exception for the same subject already existed and was returned instead. */
  created: z.boolean(),
});
export type RaiseExceptionResponse = z.infer<typeof RaiseExceptionResponseSchema>;
export const ControllerRequestsQuerySchema = z.object({
  status: ControllerRequestStatusSchema.or(z.literal("all")).optional(),
});
export type ControllerRequestsQuery = z.infer<typeof ControllerRequestsQuerySchema>;
export const ControllerRequestsResponseSchema = z.object({
  requests: z.array(ControllerRequestSchema),
  /** The treasury every request targets; null when no deployment is configured. */
  treasury: z.string().nullable(),
});
export type ControllerRequestsResponse = z.infer<typeof ControllerRequestsResponseSchema>;

// Ledger and reconciliation
export const LedgerQuerySchema = z.object({
  purchaseId: IdSchema.optional(),
  /** Rows that debit or credit this account. */
  account: LedgerAccountSchema.optional(),
  /** Split lines booked to this department. */
  department: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type LedgerQuery = z.infer<typeof LedgerQuerySchema>;
export const BalanceSchema = z.object({
  account: LedgerAccountSchema,
  debitsAtomic: AtomicAmountSchema,
  creditsAtomic: AtomicAmountSchema,
  /** debits - credits; asset and expense accounts read positive. */
  netAtomic: SignedAtomicSchema,
});
export type Balance = z.infer<typeof BalanceSchema>;
export const DepartmentBalanceSchema = BalanceSchema.extend({ department: z.string().min(1) });
export type DepartmentBalance = z.infer<typeof DepartmentBalanceSchema>;
/** Fusion allocation breakdown: a purchase's planned department share beside what the books expensed for it. */
export const AllocationBreakdownSchema = z.object({
  purchaseId: IdSchema,
  purchaseGroupId: IdSchema.nullable(),
  department: z.string().min(1),
  /** Planned share from the purchase's allocations; null when the purchase has none for this department. */
  allocatedAtomic: AtomicAmountSchema.nullable(),
  /** Net data-expense booked to this purchase and department. */
  bookedAtomic: SignedAtomicSchema,
});
export type AllocationBreakdown = z.infer<typeof AllocationBreakdownSchema>;
export const LedgerResponseSchema = z.object({
  /** Filtered by the query; newest first when `limit` is given. */
  entries: z.array(FinancialEntrySchema),
  /** Whole-book totals, regardless of the entry filters. */
  balances: z.array(BalanceSchema),
  departments: z.array(DepartmentBalanceSchema),
  allocations: z.array(AllocationBreakdownSchema),
});
export type LedgerResponse = z.infer<typeof LedgerResponseSchema>;
export const ReconciliationResponseSchema = z.object({
  lastRun: ReconciliationRunSchema.nullable(),
  openExceptions: z.array(ExceptionRecordSchema),
  note: z.string().optional(),
});
export type ReconciliationResponse = z.infer<typeof ReconciliationResponseSchema>;
export const RunReconciliationResponseSchema = z.object({ run: ReconciliationRunSchema });
export type RunReconciliationResponse = z.infer<typeof RunReconciliationResponseSchema>;

// GET /events (SSE)
export const SseQuerySchema = z.object({
  since: IsoDateTimeSchema.optional(),
  replay: z.number().int().min(0).max(500).optional(),
});
export type SseQuery = z.infer<typeof SseQuerySchema>;
export type SseMessage =
  | { type: "activity"; id: string; event: z.infer<typeof ActivityEventSchema> }
  | { type: "indexer"; status: IndexerStatus }
  | { type: "heartbeat" };
