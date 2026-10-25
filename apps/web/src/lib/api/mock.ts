import type { Hex, LedgerAccount } from "@overflow/schemas";
import { ApiError, type OverflowApi } from "./client";
import type { Balance, DepartmentBalance } from "./contracts";
import * as fx from "../mocks/fixtures";
import { getTreasurySim } from "../mocks/treasury-sim";

// ---------------------------------------------------------------------------
// MOCK client: serves the fixtures with a short delay so loading states show.
// Reads return fixture records. Writes return only what a service could have
// said without touching the chain: a PROPOSED row, a RESERVED row with an
// "unknown" submission, an opened exception. Nothing here ever reports a
// funded escrow, a settlement or a confirmed pause, because no chain event
// happened.
// ---------------------------------------------------------------------------

const LATENCY_MS = 250;
const delay = <T>(value: T, ms = LATENCY_MS): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));
const notFound = (what: string, id: string) => new ApiError(404, "not_found", `${what} ${id} not found (${fx.MOCK_LABEL})`);

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

    createMission: (body) =>
      delay({
        mission: {
          ...fx.mission,
          id: `mission-mock-${Date.now()}`,
          goal: body.goal,
          budgetAtomic: body.budgetAtomic,
          rootNodeId: body.rootNodeId ?? fx.mission.rootNodeId,
          ownerAgentId: body.ownerAgentId,
          status: "draft",
          createdAt: new Date().toISOString(),
        },
      }),
    planMission: (id) => {
      if (id !== fx.mission.id) return Promise.reject(notFound("mission", id));
      return delay({ mission: { ...fx.mission, status: "planning" }, requests: fx.requests });
    },
    runMission: (id) => {
      if (id !== fx.mission.id) return Promise.reject(notFound("mission", id));
      return delay({ mission: fx.mission, runId: "run-mock-1", note: `${fx.MOCK_LABEL}: no agents ran; nothing was paid` });
    },
    pauseMissionAgent: () =>
      Promise.reject(new ApiError(501, "not_wired", `${fx.MOCK_LABEL}: pausing changes contract state and the mock has no chain`)),

    listResources: (missionId) => delay({ resources: fx.resources, filtered: false, missionId }),

    proposePurchases: (missionId) => {
      if (missionId !== fx.mission.id) return Promise.reject(notFound("mission", missionId));
      const merged = fx.purchaseById("pur-merged-national");
      if (!merged) return Promise.reject(notFound("purchase", "pur-merged-national"));
      // A proposal is a PROPOSED row: no digest, no transactions, no funding.
      const { authorizationDigest: _digest, ...rest } = merged;
      void _digest;
      const proposed = { ...rest, id: "pur-proposed-national", status: "PROPOSED" as const, txHashes: [] };
      return delay({ purchases: [proposed], decisions: fx.oracleDecisions, merges: fx.fusionOutcomes });
    },
    authorizePurchase: (id) => {
      const p = fx.purchaseById(id);
      if (!p) return Promise.reject(notFound("purchase", id));
      if (p.status !== "PROPOSED") {
        return Promise.reject(new ApiError(409, "invalid_transition", `invalid purchase transition ${p.status} -> RESERVED`, { from: p.status, to: "RESERVED" }));
      }
      const digest = `0x${"d16e57".padEnd(64, "0")}` as Hex;
      return delay({
        purchase: { ...p, status: "RESERVED" as const, authorizationDigest: digest },
        authorizationDigest: digest,
        submission: { outcome: "unknown" as const, error: `${fx.MOCK_LABEL}: no facilitator; nothing was broadcast` },
        replayed: false,
      });
    },
    getPurchase: (id) => {
      const p = fx.purchaseById(id);
      if (!p) return Promise.reject(notFound("purchase", id));
      return delay({
        purchase: p,
        escrow: fx.escrowByPurchase(id) ?? null,
        chainTransactions: fx.chainTransactions.filter((t) => t.purchaseId === id),
        activity: fx.activity.filter((e) => e.purchaseId === id),
      });
    },
    getEscrow: (id) => {
      const e = fx.escrowByPurchase(id) ?? fx.escrowByAddress(id);
      if (!e) return Promise.reject(notFound("escrow", id));
      return delay({ escrow: e, chainTransactions: fx.chainTransactions.filter((t) => t.purchaseId === e.purchaseId) });
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
      // Fixture history plus the SIMULATED treasury's live events, newest first.
      let events = [...fx.activity, ...sim.events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      if (query.purchaseId) events = events.filter((e) => e.purchaseId === query.purchaseId);
      if (query.missionId) events = events.filter((e) => e.missionId === query.missionId);
      if (query.agentId) events = events.filter((e) => e.agentId === query.agentId);
      return delay({ events: events.slice(0, query.limit ?? 100) });
    },
    listExceptions: (query = {}) => {
      const status = query.status ?? "open";
      const rows = [{ ...fx.exception, request: fx.controllerRequest }];
      return delay({ exceptions: rows.filter((r) => status === "all" || r.status === status) });
    },
    decideException: (id, body) => {
      if (id !== fx.exception.id) return Promise.reject(notFound("exception", id));
      if (body.decision === "approve") {
        return Promise.reject(
          new ApiError(409, "onchain_approval_only", `${fx.MOCK_LABEL}: PAUSE_REQUEST is approved only by the treasury's NodePaused event`),
        );
      }
      return delay({
        exception: {
          ...fx.exception,
          status: "dismissed" as const,
          decision: "reject" as const,
          decisionReason: body.reason,
          resolvedBy: body.decidedBy,
          resolvedAt: new Date().toISOString(),
        },
        request: { ...fx.controllerRequest, status: "rejected" as const, resolvedAt: new Date().toISOString() },
      });
    },
    listControllerRequests: (query = {}) => {
      const status = query.status ?? "pending";
      const rows = [fx.controllerRequest, ...sim.requests].filter((r) => status === "all" || r.status === status);
      return delay({ requests: rows, treasury: fx.TREASURY_ADDRESS });
    },

    getLedger: (query = {}) => {
      const entries = query.purchaseId ? fx.ledgerEntries.filter((e) => e.purchaseId === query.purchaseId) : fx.ledgerEntries;
      // Balances always cover the whole book, as the service does; `limit` only trims the entry list.
      return delay({ entries: entries.slice(0, query.limit ?? 1000), ...sumBalances(fx.ledgerEntries) });
    },
    getReconciliation: () => delay({ lastRun: fx.reconciliationRun, openExceptions: [fx.exception], note: `${fx.MOCK_LABEL}: fixture run` }),
    runReconciliation: () => delay({ run: { ...fx.reconciliationRun, id: "rec-mock-api", trigger: "api" as const, ranAt: new Date().toISOString() } }),

    subscribe: (onMessage) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      timers.push(setTimeout(() => onMessage({ type: "indexer", status: fx.serviceStatus.indexer }), 50));
      fx.activity.forEach((event, i) => {
        timers.push(setTimeout(() => onMessage({ type: "activity", id: event.id, event }), 200 + i * 120));
      });
      const heartbeat = setInterval(() => onMessage({ type: "heartbeat" }), 15_000);
      // Live SIMULATED treasury events (payments, refusals, controller lifecycle) stream like the service's /events.
      const unsubscribeSim = sim.subscribe((event) => onMessage({ type: "activity", id: event.id, event }));
      sim.start();
      return () => {
        timers.forEach(clearTimeout);
        clearInterval(heartbeat);
        unsubscribeSim();
      };
    },
  };
}
