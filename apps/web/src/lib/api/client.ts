import type { ActivityEvent, AgentRecord, PurchaseRecord } from "@overflow/schemas";
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
  EscrowResponse,
  ExceptionsQuery,
  ExceptionsResponse,
  LedgerQuery,
  LedgerResponse,
  MissionDetailResponse,
  MissionResponse,
  MissionsResponse,
  PauseAgentBody,
  PauseAgentResponse,
  PauseMissionAgentResponse,
  PlanResponse,
  ProposeResponse,
  PurchaseResponse,
  ReconciliationResponse,
  ResourcesResponse,
  RunMissionBody,
  RunMissionResponse,
  RunReconciliationResponse,
  ServiceStatus,
  SseMessage,
  SseQuery,
  ConfirmMissionResponse,
  UpdateRequestBody,
  UpdateRequestResponse,
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

  proposePurchases(missionId: string): Promise<ProposeResponse>;
  /** Requires an Idempotency-Key; replaying the same key returns the stored result. */
  authorizePurchase(id: string, idempotencyKey: string, body?: AuthorizeBody): Promise<AuthorizeResponse>;
  getPurchase(id: string): Promise<PurchaseResponse>;
  /** `id` is a purchase id or an escrow address. */
  getEscrow(id: string): Promise<EscrowResponse>;

  listAgents(): Promise<AgentsResponse>;
  /** Opens a PAUSE_REQUEST exception with a prepared controller call; nothing is paused until the chain says so. */
  pauseAgent(id: string, body: PauseAgentBody): Promise<PauseAgentResponse>;

  listActivity(query?: ActivityQuery): Promise<ActivityResponse>;
  listExceptions(query?: ExceptionsQuery): Promise<ExceptionsResponse>;
  decideException(id: string, body: DecideExceptionBody): Promise<DecideExceptionResponse>;
  listControllerRequests(query?: ControllerRequestsQuery): Promise<ControllerRequestsResponse>;

  getLedger(query?: LedgerQuery): Promise<LedgerResponse>;
  getReconciliation(): Promise<ReconciliationResponse>;
  runReconciliation(): Promise<RunReconciliationResponse>;

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
