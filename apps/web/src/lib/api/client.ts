import type { ActivityEvent, AgentRecord, ControllerRequest, PurchaseRecord } from "@overflow/schemas";
import type {
  ActivityQuery,
  ActivityResponse,
  AgentsResponse,
  AuthorizeBody,
  AuthorizeResponse,
  ControllerRequestsQuery,
  ControllerRequestsResponse,
  CreateMissionBody,
  DecideExceptionBody,
  DecideExceptionResponse,
  EscrowListResponse,
  EscrowResponse,
  ExceptionsQuery,
  ExceptionsResponse,
  LedgerQuery,
  LedgerResponse,
  MissionDetailResponse,
  MissionResponse,
  MissionsResponse,
  NodePaymentsResponse,
  PauseAgentBody,
  PauseAgentResponse,
  PauseMissionAgentResponse,
  PlanResponse,
  ProposeResponse,
  PurchaseResponse,
  RaiseExceptionBody,
  RaiseExceptionResponse,
  ReconciliationResponse,
  ResourcesResponse,
  RunMissionBody,
  RunMissionResponse,
  RunReconciliationResponse,
  ServiceStatus,
  SseMessage,
  SseQuery,
  TreasuryNodesResponse,
  TreasuryResponse,
  ConfirmMissionResponse,
  UpdateRequestBody,
  UpdateRequestResponse,
  NetworkInfo,
  RunOrderBody,
  RunOrderResponse,
  SellerBehaviour,
  SellerResponse,
  SellersResponse,
  UpdateResourceBody,
  UpdateResourceResponse,
} from "./contracts";

export type { ActivityEvent, AgentRecord, PurchaseRecord };

/** The service's error envelope, thrown by the http client and by mock writes that refuse. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * One method per route in docs/SPEC.md "API" plus the routes the service added
 * (ledger, exceptions, controller requests, reconciliation). Reads return parsed
 * records; writes return exactly what the service reported. Nothing here moves
 * money: authorize only hands a signed proposal to the adapter.
 */
export interface OverflowApi {
  readonly source: "live" | "mock";
  status(): Promise<ServiceStatus>;

  listMissions(): Promise<MissionsResponse>;
  /** The mission with its requests, purchases and Fusion groups, as stored. */
  getMission(id: string): Promise<MissionDetailResponse>;
  createMission(body: CreateMissionBody): Promise<MissionResponse>;
  planMission(id: string): Promise<PlanResponse>;
  /** The owner edits one extracted requirement; allowed only while the mission is planning and the request is open. */
  updateRequest(missionId: string, requestId: string, body: UpdateRequestBody): Promise<UpdateRequestResponse>;
  /** planning -> confirmed; only then may purchases be proposed or the run start. Nothing is bought. */
  confirmMission(id: string): Promise<ConfirmMissionResponse>;
  runMission(id: string, body?: RunMissionBody): Promise<RunMissionResponse>;
  pauseMissionAgent(missionId: string, agentId: string): Promise<PauseMissionAgentResponse>;

  listResources(missionId?: string): Promise<ResourcesResponse>;
  /** Judge control: price, license flag or seats of a SIMULATED listing; the next Oracle/Fusion run and the next order read it. */
  updateResource(id: string, body: UpdateResourceBody): Promise<UpdateResourceResponse>;

  proposePurchases(missionId: string): Promise<ProposeResponse>;
  /** Requires an Idempotency-Key; replaying the same key returns the stored result. */
  authorizePurchase(id: string, idempotencyKey: string, body?: AuthorizeBody): Promise<AuthorizeResponse>;
  getPurchase(id: string): Promise<PurchaseResponse>;
  /** Every escrow order with its purchase status and resource label (GET /api/escrow). */
  listEscrows(): Promise<EscrowListResponse>;
  /** `id` is a purchase id or an escrow address. Terms, live chain state, chain events, sample, complaint and action gates. */
  getEscrow(id: string): Promise<EscrowResponse>;

  listAgents(): Promise<AgentsResponse>;
  /** Opens a PAUSE_REQUEST exception with a prepared controller call; nothing is paused until the chain says so. */
  pauseAgent(id: string, body: PauseAgentBody): Promise<PauseAgentResponse>;
  /** The delegation tree as the treasury holds it: getNode + remaining per node, AllowSet replay, agent labels. */
  listTreasuryNodes(): Promise<TreasuryNodesResponse>;
  /** Indexed Paid logs signed by one node, newest first. */
  listNodePayments(nodeId: number): Promise<NodePaymentsResponse>;
  /** Raises an onchain exception (pause / raise cap / new payee): a pending ControllerRequest, never a state change. */
  raiseException(body: RaiseExceptionBody): Promise<RaiseExceptionResponse>;
  getControllerRequest(id: string): Promise<ControllerRequest>;

  listActivity(query?: ActivityQuery): Promise<ActivityResponse>;
  listExceptions(query?: ExceptionsQuery): Promise<ExceptionsResponse>;
  decideException(id: string, body: DecideExceptionBody): Promise<DecideExceptionResponse>;
  listControllerRequests(query?: ControllerRequestsQuery): Promise<ControllerRequestsResponse>;

  getLedger(query?: LedgerQuery): Promise<LedgerResponse>;
  /** Onchain treasury balance and reservedTotal at one block (null with a reason when no RPC is wired) plus the USDC the open escrows hold. */
  getTreasury(): Promise<TreasuryResponse>;
  getReconciliation(): Promise<ReconciliationResponse>;
  runReconciliation(): Promise<RunReconciliationResponse>;

  // Judge controls over the SIMULATED recourse sellers (local Anvil fork only; 501 elsewhere).
  listSellers(): Promise<SellersResponse>;
  /** What this SIMULATED seller does on its next order; in memory on the service. */
  setSellerBehaviour(address: string, behaviour: SellerBehaviour): Promise<SellerResponse>;
  /** Runs one SIMULATED order now with the seller's current behaviour; answers the runner's steps, never a status. */
  runOrder(body: RunOrderBody): Promise<RunOrderResponse>;
  /** Treasury owner, floor, reservation window, token domain, relayer and deploy facts, read from the chain. */
  getNetwork(): Promise<NetworkInfo>;

  /** Subscribe to GET /events. Returns an unsubscribe function. */
  subscribe(onMessage: (m: SseMessage) => void, query?: SseQuery): () => void;
}

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** True when NEXT_PUBLIC_USE_MOCKS=1: every page then shows the MOCK badge. */
export function mocksEnabled(): boolean {
  return process.env.NEXT_PUBLIC_USE_MOCKS === "1";
}

/** True when NEXT_PUBLIC_SCRIPTED=1: the top bar shows the SCRIPTED badge. */
export function isScripted(): boolean {
  return process.env.NEXT_PUBLIC_SCRIPTED === "1";
}
