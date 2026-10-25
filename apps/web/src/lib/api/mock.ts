import {
  ActivityEventSchema,
  ESCROW_TRANSITIONS,
  MissionRecordSchema,
  ResourceRequestRecordSchema,
  ResourceRequestSchema,
  atomicToBigInt,
  formatUsdc,
  isOnchainExceptionType,
  type ActivityEvent,
  type ActivityKind,
  type ControllerRequest,
  type ExceptionRecord,
  type Hex,
  type LedgerAccount,
  type MissionRecord,
  type PurchaseRecord,
  type ReconciliationRun,
  type ResourceRequestRecord,
} from "@overflow/schemas";
import { filterEntries } from "../ledger/journal";
import * as fx from "../mocks/fixtures";
import { ApiError, type OverflowApi } from "./client";
import type { AllocationBreakdown, Balance, DepartmentBalance, SseMessage } from "./contracts";
import { getTreasurySim } from "../mocks/treasury-sim";
import { gateActions } from "../escrow/state";

// ---------------------------------------------------------------------------
// MOCK client: serves the fixtures with a short delay so loading states show.
// Reads return fixture records. Writes return only what a service could have
// said without touching the chain: a PROPOSED row, a RESERVED row with an
// "unknown" submission, an opened exception. Nothing here ever reports a
// funded escrow, a settlement or a confirmed pause, because no chain event
// happened.
// ---------------------------------------------------------------------------

const LATENCY_MS = 250;

/**
 * Purchases the mock has handed out this session: the fixtures plus the PROPOSED
 * row a mock propose creates, so getPurchase/authorizePurchase/getMission find
 * it. In memory only; a reload goes back to the fixtures.
 */
const purchaseStore = new Map<string, PurchaseRecord>(fx.purchases.map((p) => [p.id, p]));
const storedPurchase = (id: string): PurchaseRecord | undefined => purchaseStore.get(id);
const missionPurchases = (missionId: string): PurchaseRecord[] => [...purchaseStore.values()].filter((p) => p.missionId === missionId);
const delay = <T>(value: T, ms = LATENCY_MS): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));
const notFound = (what: string, id: string) => new ApiError(404, "not_found", `${what} ${id} not found (${fx.MOCK_LABEL})`);

/**
 * Exceptions and the reconciliation state the mock has handed out this session. "Run reconciliation" switches to the
 * planted run and opens its exception (once); decisions update the stored row. In memory only; a reload resets it.
 */
const exceptionStore = new Map<string, ExceptionRecord>([[fx.exception.id, fx.exception], ...([] as [string, ExceptionRecord][])]);
const controllerRequestStore = new Map<string, ControllerRequest>([[fx.controllerRequest.id, fx.controllerRequest]]);
const reconState: { lastRun: ReconciliationRun } = { lastRun: fx.reconciliationRun };
const requestFor = (exceptionId: string): ControllerRequest | null => [...controllerRequestStore.values()].find((r) => r.exceptionId === exceptionId) ?? null;

/**
 * Missions, their requests and the activity the mock has handed out this session: the fixtures plus whatever
 * createMission / planMission / updateRequest / confirmMission / runMission wrote, so the detail page can follow
 * the service's state machine (draft -> planning -> confirmed -> active) without a service. In memory only; a
 * reload goes back to the fixtures. The mock plan derives requests locally and says so: no model is called.
 */
const missionStore = new Map<string, MissionRecord>([[fx.mission.id, fx.mission]]);
const missionRequestStore = new Map<string, ResourceRequestRecord>(fx.requests.map((r) => [r.id, r]));
const activityStore: ActivityEvent[] = [...fx.activity];
const listeners = new Set<(m: SseMessage) => void>();
let seq = 0;
const missionRequests = (missionId: string): ResourceRequestRecord[] => [...missionRequestStore.values()].filter((r) => r.missionId === missionId);
function record(kind: ActivityKind, message: string, extra: { missionId?: string; agentId?: string }): ActivityEvent {
  const event = ActivityEventSchema.parse({ id: `ev-mock-${++seq}`, at: new Date().toISOString(), kind, message: `${fx.MOCK_LABEL}: ${message}`, ...extra, simulated: true });
  activityStore.push(event);
  for (const l of listeners) l({ type: "activity", id: event.id, event });
  return event;
}
const MOCK_PRICE_CAP = 15_000_000n; // 15 USDC
/** Last day of the last complete month (UTC), as the Oracle's clampToPresent computes it. */
function lastCompleteMonthEnd(now: Date): string {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return new Date(first.getTime() - 86_400_000).toISOString().slice(0, 10);
}
/** MOCK plan: one request derived from the mission's own fields (goal, horizon, allowed formats, budget). No model, no listing chosen. */
function mockPlan(mission: MissionRecord): ResourceRequestRecord {
  const end = lastCompleteMonthEnd(new Date());
  const defaultStart = `${Number(end.slice(0, 4)) - 1}${end.slice(4, 8)}01`;
  const horizon = mission.horizon ?? { start: defaultStart, end };
  const budget = atomicToBigInt(mission.budgetAtomic);
  return ResourceRequestRecordSchema.parse({
    id: `req-mock-${++seq}`,
    missionId: mission.id,
    agentId: mission.ownerAgentId ?? "agent-orchestrator",
    status: "open",
    topic: mission.goal.slice(0, 80),
    regions: ["US"],
    dateRange: horizon.end <= end ? horizon : { start: horizon.start <= end ? horizon.start : end, end },
    granularity: "monthly",
    requiredFields: ["date", "region", "value"],
    format: mission.allowedFormats,
    license: "company-use",
    freshness: { maxAgeDays: 90 },
    maxPriceAtomic: (budget < MOCK_PRICE_CAP ? budget : MOCK_PRICE_CAP).toString(),
    createdAt: new Date().toISOString(),
  });
}
const openExceptions = (): ExceptionRecord[] => [...exceptionStore.values()].filter((e) => e.status === "open");

/** The service's allocation breakdown over the fixture books: booked data-expense per (purchase, department) beside the plan. */
function allocationBreakdown(entries: typeof fx.ledgerEntries): AllocationBreakdown[] {
  const booked = new Map<string, bigint>();
  for (const e of entries) {
    if (!e.purchaseId || !e.department) continue;
    const k = `${e.purchaseId}\u0000${e.department}`;
    const v = BigInt(e.amountAtomic);
    booked.set(k, (booked.get(k) ?? 0n) + (e.debitAccount === "data-expense" ? v : 0n) - (e.creditAccount === "data-expense" ? v : 0n));
  }
  const rows = new Map<string, AllocationBreakdown>();
  const purchaseIds = new Set([...booked.keys()].map((k) => k.split("\u0000")[0]!));
  for (const purchaseId of purchaseIds) {
    const purchase = storedPurchase(purchaseId);
    const departments = new Set([
      ...[...booked.keys()].filter((k) => k.startsWith(`${purchaseId}\u0000`)).map((k) => k.split("\u0000")[1]!),
      ...(purchase?.allocations.map((a) => a.department) ?? []),
    ]);
    for (const department of departments) {
      const planned = purchase?.allocations.filter((a) => a.department === department) ?? [];
      rows.set(`${purchaseId}\u0000${department}`, {
        purchaseId,
        purchaseGroupId: purchase?.purchaseGroupId ?? null,
        department,
        allocatedAtomic: planned.length > 0 ? planned.reduce((s, a) => s + BigInt(a.amountAtomic), 0n).toString() : null,
        bookedAtomic: (booked.get(`${purchaseId}\u0000${department}`) ?? 0n).toString(),
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.purchaseId.localeCompare(b.purchaseId) || a.department.localeCompare(b.department));
}

function sumBalances(entries: typeof fx.ledgerEntries): { balances: Balance[]; departments: DepartmentBalance[] } {
  const acc = new Map<LedgerAccount, { debits: bigint; credits: bigint }>();
  const dept = new Map<string, { account: LedgerAccount; department: string; debits: bigint; credits: bigint }>();
  const bump = (m: Map<string, { debits: bigint; credits: bigint }>, k: string, side: "debits" | "credits", v: bigint) => {
    const cur = m.get(k) ?? { debits: 0n, credits: 0n };
    cur[side] += v;
    m.set(k, cur);
  };
  for (const e of entries) {
    const v = BigInt(e.amountAtomic);
    bump(acc as Map<string, { debits: bigint; credits: bigint }>, e.debitAccount, "debits", v);
    bump(acc as Map<string, { debits: bigint; credits: bigint }>, e.creditAccount, "credits", v);
    if (e.department) {
      const k = `${e.debitAccount}#${e.department}`;
      const cur = dept.get(k) ?? { account: e.debitAccount, department: e.department, debits: 0n, credits: 0n };
      cur.debits += v;
      dept.set(k, cur);
    }
  }
  const row = (account: LedgerAccount, s: { debits: bigint; credits: bigint }): Balance => ({
    account,
    debitsAtomic: s.debits.toString(),
    creditsAtomic: s.credits.toString(),
    netAtomic: (s.debits - s.credits).toString(),
  });
  return {
    balances: [...acc.entries()].map(([a, s]) => row(a, s)),
    departments: [...dept.values()].map((d) => ({ ...row(d.account, d), department: d.department })),
  };
}

export function createMockApi(): OverflowApi {
  // The SIMULATED treasury behind the agents page: bars, refusals and the controller lifecycle, all labelled.
  const sim = getTreasurySim();
  return {
    source: "mock",
    status: () => delay(fx.serviceStatus),

    listMissions: () => delay({ missions: [...missionStore.values()] }),
    getMission: (id) => {
      const mission = missionStore.get(id);
      if (!mission) return Promise.reject(notFound("mission", id));
      return delay({ mission, requests: missionRequests(id), purchases: missionPurchases(id), groups: id === fx.mission.id ? [fx.purchaseGroup] : [] });
    },

    createMission: (body) => {
      const mission = MissionRecordSchema.parse({
        id: `mission-mock-${Date.now()}`,
        organizationId: fx.mission.organizationId,
        goal: body.goal,
        budgetAtomic: body.budgetAtomic,
        rootNodeId: body.rootNodeId ?? fx.mission.rootNodeId,
        ownerAgentId: body.ownerAgentId ?? "agent-orchestrator",
        ...(body.horizon ? { horizon: body.horizon } : {}),
        ...(body.allowedFormats ? { allowedFormats: body.allowedFormats } : {}),
        status: "draft",
        createdAt: new Date().toISOString(),
      });
      missionStore.set(mission.id, mission);
      record("mission.created", `mission created: ${mission.goal} (budget ${formatUsdc(mission.budgetAtomic)} USDC)`, { missionId: mission.id, agentId: mission.ownerAgentId });
      return delay({ mission });
    },
    // The service's plan: withdraw the earlier open requests, insert the new set, mission -> planning. Here the set is
    // derived locally from the mission's fields and labelled MOCK; no model is called and no listing is chosen.
    planMission: (id) => {
      const mission = missionStore.get(id);
      if (!mission) return Promise.reject(notFound("mission", id));
      for (const r of missionRequests(id)) if (r.status === "open") missionRequestStore.set(r.id, { ...r, status: "withdrawn" });
      const request = mockPlan(mission);
      missionRequestStore.set(request.id, request);
      const updated: MissionRecord = { ...mission, status: "planning" };
      missionStore.set(id, updated);
      record("oracle.model_call", `no model call; one request derived from the goal, horizon and allowed formats. It chooses no listing and authorizes nothing`, { missionId: id, agentId: request.agentId });
      return delay({ mission: updated, requests: [request] });
    },
    // The service's PUT rules and codes: 404, 409 not_editable (mission not planning or request not open), 409 over_budget.
    updateRequest: (missionId, requestId, body) => {
      const mission = missionStore.get(missionId);
      if (!mission) return Promise.reject(notFound("mission", missionId));
      const current = missionRequestStore.get(requestId);
      if (!current || current.missionId !== missionId) return Promise.reject(notFound("request", requestId));
      if (mission.status !== "planning" || current.status !== "open") {
        return Promise.reject(
          new ApiError(409, "not_editable", `request ${requestId} is ${current.status} and mission ${missionId} is ${mission.status}; requirements are editable only while the mission is planning and the request is open (${fx.MOCK_LABEL})`, {
            missionStatus: mission.status,
            requestStatus: current.status,
          }),
        );
      }
      const fields = ResourceRequestSchema.parse(body);
      if (atomicToBigInt(fields.maxPriceAtomic) > atomicToBigInt(mission.budgetAtomic)) {
        return Promise.reject(new ApiError(409, "over_budget", `maxPrice ${formatUsdc(fields.maxPriceAtomic)} USDC exceeds the mission budget ${formatUsdc(mission.budgetAtomic)} USDC (${fx.MOCK_LABEL})`));
      }
      const request: ResourceRequestRecord = { ...current, ...fields };
      missionRequestStore.set(requestId, request);
      record("mission.requirement_edited", `owner edited requirement ${requestId}: ${request.topic} (${request.regions.join(", ")}; ${request.dateRange.start}..${request.dateRange.end}; ${request.granularity}; max ${formatUsdc(request.maxPriceAtomic)} USDC). Nothing bought.`, { missionId, agentId: request.agentId });
      return delay({ request });
    },
    confirmMission: (id) => {
      const mission = missionStore.get(id);
      if (!mission) return Promise.reject(notFound("mission", id));
      if (mission.status !== "planning") {
        return Promise.reject(new ApiError(409, "not_planning", `mission ${id} is ${mission.status}; only a planning mission's requirements can be confirmed (${fx.MOCK_LABEL})`, { status: mission.status }));
      }
      const requests = missionRequests(id);
      const open = requests.filter((r) => r.status === "open");
      if (open.length === 0) return Promise.reject(new ApiError(409, "no_open_requests", `mission ${id} has no open requirements to confirm (${fx.MOCK_LABEL})`, { missionId: id }));
      const updated: MissionRecord = { ...mission, status: "confirmed" };
      missionStore.set(id, updated);
      record("mission.confirmed", `owner confirmed ${open.length} requirement(s) for ${open.map((r) => r.topic).join("; ")}. Purchases may now be proposed; nothing bought yet.`, { missionId: id, agentId: mission.ownerAgentId });
      return delay({ mission: updated, requests });
    },
    // Accepting a run changes only the stored status. No agent runs, no tool call, no payment: the one event says so.
    runMission: (id) => {
      const mission = missionStore.get(id);
      if (!mission) return Promise.reject(notFound("mission", id));
      if (mission.status === "planning") {
        return Promise.reject(new ApiError(409, "requirements_unconfirmed", `mission ${id} has extracted requirements awaiting the owner's confirmation; confirm first (${fx.MOCK_LABEL})`, { missionId: id }));
      }
      const updated: MissionRecord = { ...mission, status: "active" };
      missionStore.set(id, updated);
      record("mission.run", `run accepted; no agents ran and nothing was paid`, { missionId: id, agentId: mission.ownerAgentId });
      return delay({ mission: updated, runId: `run-mock-${++seq}`, note: `${fx.MOCK_LABEL}: no agents ran; nothing was paid` });
    },
    pauseMissionAgent: () =>
      Promise.reject(new ApiError(501, "not_wired", `${fx.MOCK_LABEL}: pausing changes contract state and the mock has no chain`)),

    listResources: (missionId) => delay({ resources: fx.resources, filtered: false, missionId }),

    proposePurchases: (missionId) => {
      const mission = missionStore.get(missionId);
      if (!mission) return Promise.reject(notFound("mission", missionId));
      if (mission.status === "planning") {
        return Promise.reject(new ApiError(409, "requirements_unconfirmed", `mission ${missionId} has extracted requirements awaiting the owner's confirmation; confirm first (${fx.MOCK_LABEL})`, { missionId }));
      }
      if (missionId !== fx.mission.id) return Promise.reject(new ApiError(409, "no_open_requests", `${fx.MOCK_LABEL}: Oracle + Fusion run only over the fixture mission's requests; nothing proposed for ${missionId}`, { missionId }));
      const merged = fx.purchaseById("pur-merged-national");
      if (!merged) return Promise.reject(notFound("purchase", "pur-merged-national"));
      // A proposal is a PROPOSED row: no digest, no transactions, no funding. Replaying keeps the same row (idempotent).
      const { authorizationDigest: _digest, ...rest } = merged;
      void _digest;
      const existing = purchaseStore.get("pur-proposed-national");
      const proposed: PurchaseRecord = existing ?? {
        ...rest,
        id: "pur-proposed-national",
        status: "PROPOSED",
        txHashes: [],
        idempotencyKey: `propose:${fx.mission.id}:res-cpi-national:req-finance-cpi,req-research-cpi`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      purchaseStore.set(proposed.id, proposed);
      return delay({ purchases: [proposed], decisions: fx.oracleDecisions, merges: fx.fusionOutcomes });
    },
    authorizePurchase: (id) => {
      const p = storedPurchase(id);
      if (!p) return Promise.reject(notFound("purchase", id));
      if (p.status !== "PROPOSED") {
        return Promise.reject(new ApiError(409, "invalid_transition", `invalid purchase transition ${p.status} -> RESERVED`, { from: p.status, to: "RESERVED" }));
      }
      const digest = `0x${"d16e57".padEnd(64, "0")}` as Hex;
      const reserved: PurchaseRecord = { ...p, status: "RESERVED", authorizationDigest: digest, updatedAt: new Date().toISOString() };
      purchaseStore.set(id, reserved);
      return delay({
        purchase: reserved,
        authorizationDigest: digest,
        submission: { outcome: "unknown" as const, error: `${fx.MOCK_LABEL}: no facilitator; nothing was broadcast` },
        replayed: false,
      });
    },
    getPurchase: (id) => {
      const p = storedPurchase(id);
      if (!p) return Promise.reject(notFound("purchase", id));
      return delay({
        purchase: p,
        escrow: fx.escrowByPurchase(id) ?? null,
        chainTransactions: fx.chainTransactions.filter((t) => t.purchaseId === id),
        activity: fx.activity.filter((e) => e.purchaseId === id),
      });
    },
    listEscrows: () => delay({ escrows: fx.escrows.map(fx.escrowSummary) }),
    // MOCK detail: stored fixtures plus a labelled chain snapshot judged at the client's clock. The gates come from
    // the same contract mirror the service uses; nothing here is a success a chain confirmed.
    getEscrow: (id) => {
      const e = fx.escrowByPurchase(id) ?? fx.escrowByAddress(id);
      if (!e) return Promise.reject(notFound("escrow", id));
      const purchase = storedPurchase(e.purchaseId);
      if (!purchase) return Promise.reject(notFound("purchase", e.purchaseId));
      const now = Math.floor(Date.now() / 1000);
      const chain = fx.escrowChain(e, now);
      const complaint = fx.complaintByPurchase(e.purchaseId) ?? null;
      const actions = gateActions({
        status: chain.status,
        revealDeadline: BigInt(e.revealDeadline),
        challengeEnd: BigInt(chain.challengeEnd),
        balance: BigInt(chain.balanceAtomic),
        now: BigInt(now),
        complaintReady: Boolean(complaint && complaint.cipherProofVerified && complaint.plainProofVerified && complaint.cheatVerified),
      });
      return delay({
        escrow: e,
        purchase,
        resource: fx.escrowResource(e.purchaseId),
        chain,
        chainTransactions: fx.chainTransactions.filter((t) => t.purchaseId === e.purchaseId),
        sample: fx.sampleByPurchase(e.purchaseId) ?? null,
        complaint,
        actions,
        activity: fx.activity.filter((ev) => ev.purchaseId === e.purchaseId),
        simulated: true,
      });
    },

    listAgents: () => {
      const nodes = new Map(fx.agents.map((a) => [a.id, { ...a, node: null as null, children: [] as never[] }]));
      type Node = (typeof nodes extends Map<string, infer V> ? V : never) & { children: Node[] };
      const roots: Node[] = [];
      for (const n of nodes.values() as Iterable<Node>) {
        const parent = n.parentAgentId ? (nodes.get(n.parentAgentId) as Node | undefined) : undefined;
        if (parent) parent.children.push(n);
        else roots.push(n);
      }
      return delay({ agents: fx.agents, tree: roots });
    },
    pauseAgent: (id, body) => {
      const a = fx.agents.find((x) => x.id === id);
      if (!a) return Promise.reject(notFound("agent", id));
      if (!a.nodeId) return Promise.reject(new ApiError(409, "no_node_yet", `agent ${id} has no treasury node onchain yet`));
      return delay({
        exception: { ...fx.exception, reason: body.reason, details: { nodeId: a.nodeId, agentId: a.id } },
        request: { ...fx.controllerRequest, action: { kind: "pause" as const, nodeId: a.nodeId }, reason: body.reason },
      });
    },

    listTreasuryNodes: () => delay(sim.snapshot()),
    listNodePayments: (nodeId) => delay(sim.paymentsOf(nodeId)),
    raiseException: (body) => {
      try {
        return delay(sim.raise(body));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    getControllerRequest: (id) => {
      const r = sim.request(id) ?? (id === fx.controllerRequest.id ? fx.controllerRequest : undefined);
      return r ? delay(r) : Promise.reject(notFound("controller request", id));
    },

    listActivity: (query = {}) => {
      // Mock writes' events plus the SIMULATED treasury's live events, newest first.
      let events = [...activityStore, ...sim.events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      if (query.purchaseId) events = events.filter((e) => e.purchaseId === query.purchaseId);
      if (query.missionId) events = events.filter((e) => e.missionId === query.missionId);
      if (query.agentId) events = events.filter((e) => e.agentId === query.agentId);
      if (query.kind) events = events.filter((e) => e.kind === query.kind);
      return delay({ events: events.slice(0, query.limit ?? 100) });
    },
    listExceptions: (query = {}) => {
      const status = query.status ?? "open";
      const rows = [...exceptionStore.values()].filter((e) => status === "all" || e.status === status);
      return delay({ exceptions: rows.map((e) => ({ ...e, request: requestFor(e.id) })) });
    },
    // The service's decide rules, with its exact error codes: 404, 409 already_decided, 403 self_resolution,
    // 409 onchain_approval_required. Only the returned record changes status; nothing claims a chain outcome.
    decideException: (id, body) => {
      const current = exceptionStore.get(id);
      if (!current) return Promise.reject(notFound("exception", id));
      if (current.status !== "open") {
        return Promise.reject(new ApiError(409, "already_decided", `exception ${id} is already ${current.status} (${fx.MOCK_LABEL})`, { exceptionId: id, status: current.status }));
      }
      if (current.requestedBy !== undefined && current.requestedBy === body.decidedBy) {
        return Promise.reject(new ApiError(403, "self_resolution", `${body.decidedBy} raised exception ${id} and cannot decide it (${fx.MOCK_LABEL})`, { exceptionId: id, principal: body.decidedBy }));
      }
      const request = requestFor(id);
      if (isOnchainExceptionType(current.type) && body.decision === "approve") {
        return Promise.reject(
          new ApiError(409, "onchain_approval_required", `${fx.MOCK_LABEL}: ${current.type} is approved only by the treasury event the controller's Coinbase Wallet call emits`, { exceptionId: id, requestId: request?.id }),
        );
      }
      const resolvedAt = new Date().toISOString();
      const exception: ExceptionRecord = {
        ...current,
        status: body.decision === "approve" ? "resolved" : "dismissed",
        decision: body.decision,
        decisionReason: body.reason,
        resolvedBy: body.decidedBy,
        resolvedAt,
      };
      exceptionStore.set(id, exception);
      let updated: ControllerRequest | null = null;
      if (request && request.status === "pending") {
        updated = { ...request, status: "rejected", resolvedAt };
        controllerRequestStore.set(request.id, updated);
      }
      return delay({ exception, request: updated ?? request });
    },
    listControllerRequests: (query = {}) => {
      const status = query.status ?? "pending";
      const rows = [...controllerRequestStore.values(), ...sim.requests].filter((r) => status === "all" || r.status === status);
      return delay({ requests: rows, treasury: fx.TREASURY_ADDRESS });
    },

    getLedger: (query = {}) => {
      const entries = filterEntries(fx.ledgerEntries, query);
      // Balances and the breakdown always cover the whole book, as the service does; filters and `limit` only trim the entry list.
      return delay({ entries: entries.slice(0, query.limit ?? 1000), ...sumBalances(fx.ledgerEntries), allocations: allocationBreakdown(fx.ledgerEntries) });
    },
    getReconciliation: () => delay({ lastRun: reconState.lastRun, openExceptions: openExceptions(), note: `${fx.MOCK_LABEL}: fixture run` }),
    // MOCK chain reading: the balance the fixture reconciliation run recorded at its block; reservedTotal is what the
    // treasury would hold for signed, unsettled coinbase-facilitator payments (the fixtures have none, so 0).
    // Escrow commitment is the fixture escrows that mirror a confirmed OrderFunded.
    getTreasury: () => {
      const open = fx.escrows.filter((e) => ESCROW_TRANSITIONS[e.status].length > 0);
      const funded = open.filter((e) => e.status === "Funded" || e.status === "Revealed");
      const reserved = [...purchaseStore.values()]
        .filter((p) => p.paymentPath === "coinbase-facilitator" && (p.status === "RESERVED" || p.status === "PAYMENT_PENDING"))
        .reduce((sum, p) => sum + atomicToBigInt(p.amountAtomic), 0n);
      return delay({
        treasury: fx.TREASURY_ADDRESS,
        chain: {
          blockNumber: fx.reconciliationRun.blockNumber,
          balanceAtomic: fx.reconciliationRun.treasuryChainAtomic,
          reservedTotalAtomic: reserved.toString(),
          usdc: fx.USDC_ADDRESS,
          readAt: new Date().toISOString(),
        },
        escrow: {
          openOrders: open.length,
          fundedOrders: funded.length,
          committedAtomic: funded.reduce((sum, e) => sum + atomicToBigInt(e.amountAtomic), 0n).toString(),
          orders: open.map((e) => ({
            purchaseId: e.purchaseId,
            escrowAddress: e.escrowAddress,
            status: e.status,
            amountAtomic: e.amountAtomic,
            funded: e.status === "Funded" || e.status === "Revealed",
          })),
        },
      });
    },
    // MOCK: a run "finds" the planted 0.50 USDC treasury difference and opens its exception once (an open subject is never duplicated).
    runReconciliation: () => {
      const run: ReconciliationRun = { ...fx.reconciliationRunPlanted, ranAt: new Date().toISOString() };
      const alreadyOpen = openExceptions().some((e) => e.type === "RECONCILIATION_DIFF" && e.subject === fx.plantedException.subject);
      if (!alreadyOpen) exceptionStore.set(fx.plantedException.id, { ...fx.plantedException, openedAt: run.ranAt });
      reconState.lastRun = { ...run, exceptionIds: alreadyOpen ? [] : run.exceptionIds };
      return delay({ run: reconState.lastRun });
    },

    subscribe: (onMessage) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      timers.push(setTimeout(() => onMessage({ type: "indexer", status: fx.serviceStatus.indexer }), 50));
      fx.activity.forEach((event, i) => {
        timers.push(setTimeout(() => onMessage({ type: "activity", id: event.id, event }), 200 + i * 120));
      });
      const heartbeat = setInterval(() => onMessage({ type: "heartbeat" }), 15_000);
      listeners.add(onMessage); // mock writes publish their event here, as the service's /events would
      // Live SIMULATED treasury events (payments, refusals, controller lifecycle) stream like the service's /events.
      const unsubscribeSim = sim.subscribe((event) => onMessage({ type: "activity", id: event.id, event }));
      sim.start();
      return () => {
        timers.forEach(clearTimeout);
        clearInterval(heartbeat);
        listeners.delete(onMessage);
        unsubscribeSim();
      };
    },
  };
}
