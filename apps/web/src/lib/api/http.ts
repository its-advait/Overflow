import type { z } from "zod";
import {
  ActivityResponseSchema,
  AgentsResponseSchema,
  ApiErrorBodySchema,
  AuthorizeResponseSchema,
  ConfirmMissionResponseSchema,
  ControllerRequestsResponseSchema,
  DecideExceptionResponseSchema,
  EscrowResponseSchema,
  ExceptionsResponseSchema,
  IndexerStatusSchema,
  LedgerResponseSchema,
  MissionDetailResponseSchema,
  MissionResponseSchema,
  MissionsResponseSchema,
  PauseAgentResponseSchema,
  PauseMissionAgentResponseSchema,
  PlanResponseSchema,
  ProposeResponseSchema,
  PurchaseResponseSchema,
  ReconciliationResponseSchema,
  ResourcesResponseSchema,
  RunMissionResponseSchema,
  RunReconciliationResponseSchema,
  ServiceStatusSchema,
  TreasuryResponseSchema,
  UpdateRequestResponseSchema,
  type SseMessage,
  type SseQuery,
} from "./contracts";
import { ActivityEventSchema } from "@overflow/schemas";
import { API_BASE, ApiError, type OverflowApi } from "./client";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function request<S extends z.ZodType>(
  base: string,
  schema: S,
  path: string,
  init: { method?: "GET" | "POST" | "PUT"; body?: unknown; headers?: Record<string, string> } = {},
): Promise<z.infer<S>> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, "invalid_json", `non-JSON response from ${path}`);
  }
  if (!res.ok) {
    const parsed = ApiErrorBodySchema.safeParse(json);
    if (parsed.success) {
      const e = parsed.data.error;
      throw new ApiError(res.status, e.code, e.message, e.details, e.requestId);
    }
    throw new ApiError(res.status, "http_error", `${res.status} from ${path}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(res.status, "response_validation_error", `response from ${path} failed validation`, parsed.error.issues);
  }
  return parsed.data;
}

/** Fetch-backed client for apps/service. Every response is parsed before it is returned. */
export function createHttpApi(base: string = API_BASE): OverflowApi {
  return {
    source: "live",
    status: () => request(base, ServiceStatusSchema, "/"),

    listMissions: () => request(base, MissionsResponseSchema, "/api/missions"),
    getMission: (id) => request(base, MissionDetailResponseSchema, `/api/missions/${enc(id)}`),
    createMission: (body) => request(base, MissionResponseSchema, "/api/missions", { method: "POST", body }),
    planMission: (id) => request(base, PlanResponseSchema, `/api/missions/${enc(id)}/plan`, { method: "POST" }),
    updateRequest: (missionId, requestId, body) =>
      request(base, UpdateRequestResponseSchema, `/api/missions/${enc(missionId)}/requests/${enc(requestId)}`, { method: "PUT", body }),
    confirmMission: (id) => request(base, ConfirmMissionResponseSchema, `/api/missions/${enc(id)}/confirm`, { method: "POST" }),
    runMission: (id, body = {}) =>
      request(base, RunMissionResponseSchema, `/api/missions/${enc(id)}/run`, { method: "POST", body }),
    pauseMissionAgent: (missionId, agentId) =>
      request(base, PauseMissionAgentResponseSchema, `/api/missions/${enc(missionId)}/agents/${enc(agentId)}/pause`, {
        method: "POST",
      }),

    listResources: (missionId) => request(base, ResourcesResponseSchema, `/api/resources${qs({ missionId })}`),

    proposePurchases: (missionId) =>
      request(base, ProposeResponseSchema, "/api/purchases/propose", { method: "POST", body: { missionId } }),
    authorizePurchase: (id, idempotencyKey, body = {}) =>
      request(base, AuthorizeResponseSchema, `/api/purchases/${enc(id)}/authorize`, {
        method: "POST",
        body,
        headers: { [IDEMPOTENCY_HEADER]: idempotencyKey },
      }),
    getPurchase: (id) => request(base, PurchaseResponseSchema, `/api/purchases/${enc(id)}`),
    getEscrow: (id) => request(base, EscrowResponseSchema, `/api/escrow/${enc(id)}`),

    listAgents: () => request(base, AgentsResponseSchema, "/api/agents"),
    pauseAgent: (id, body) => request(base, PauseAgentResponseSchema, `/api/agents/${enc(id)}/pause`, { method: "POST", body }),

    listActivity: (query = {}) => request(base, ActivityResponseSchema, `/api/activity${qs(query)}`),
    listExceptions: (query = {}) => request(base, ExceptionsResponseSchema, `/api/exceptions${qs(query)}`),
    decideException: (id, body) =>
      request(base, DecideExceptionResponseSchema, `/api/exceptions/${enc(id)}/decide`, { method: "POST", body }),
    listControllerRequests: (query = {}) =>
      request(base, ControllerRequestsResponseSchema, `/api/controller-requests${qs(query)}`),

    getLedger: (query = {}) => request(base, LedgerResponseSchema, `/api/ledger${qs(query)}`),
    getTreasury: () => request(base, TreasuryResponseSchema, "/api/treasury"),
    getReconciliation: () => request(base, ReconciliationResponseSchema, "/api/reconciliation"),
    runReconciliation: () => request(base, RunReconciliationResponseSchema, "/api/reconciliation/run", { method: "POST" }),

    subscribe: (onMessage, query = {}) => subscribeSse(base, onMessage, query),
  };
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function subscribeSse(base: string, onMessage: (m: SseMessage) => void, query: SseQuery): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const es = new EventSource(`${base}/events${qs(query)}`);
  es.addEventListener("activity", (e) => {
    const parsed = ActivityEventSchema.safeParse(JSON.parse((e as MessageEvent<string>).data));
    if (parsed.success) onMessage({ type: "activity", id: (e as MessageEvent).lastEventId, event: parsed.data });
  });
  es.addEventListener("indexer", (e) => {
    const parsed = IndexerStatusSchema.safeParse(JSON.parse((e as MessageEvent<string>).data));
    if (parsed.success) onMessage({ type: "indexer", status: parsed.data });
  });
  es.addEventListener("heartbeat", () => onMessage({ type: "heartbeat" }));
  return () => es.close();
}
