import { computeOrderId, type ResourceRequestRecord } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedCatalog } from "../../orchestration/catalog.js";
import { createOraclePort, type OrderTermsPort } from "../../orchestration/oracle-port.js";
import { b32, ESCROW, NOW, SELLER, testDatabase, TREASURY } from "../../test-db.js";
import { createApp } from "../app.js";

// Fusion acceptance tests (docs/SPEC.md "Fusion" > Acceptance tests) through
// POST /api/purchases/propose, on the SIMULATED P5.1 catalog with a labeled
// SIMULATED OrderTermsPort. No model: requests are inserted directly.

const JSON_HEADERS = { "content-type": "application/json" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json() as Promise<any>;
const NATIONAL = "listing-national-monthly-2024-2026";
const CALIFORNIA = "listing-california-monthly-2024-2026";
const SINGLE_USER = "listing-national-monthly-2024-2026-single-user";

/** SIMULATED order terms: fixed seller and escrow, termsHash b32(9), orderId from fixed ABI fields. */
const simulatedOrderTerms: OrderTermsPort = {
  async prepare(input) {
    const termsHash = b32(9);
    return {
      sellerAddress: SELLER,
      escrowAddress: ESCROW,
      termsHash,
      orderIdBytes32: computeOrderId({
        missionId: input.mission.id,
        resourceId: input.resource.id,
        buyer: input.buyerTreasury,
        seller: SELLER,
        amountAtomic: input.amountAtomic,
        termsHash,
        salt: b32(1),
      }),
      authorizationExpiresAt: "2026-10-24T16:10:00.000Z",
      simulated: true,
    };
  },
};

type RequestSeed = Omit<ResourceRequestRecord, "id" | "createdAt" | "status" | "missionId">;

/** Spec "Structured requests": Agent A (research) wants California, monthly, 2024-2026. */
const RESEARCH_CALIFORNIA: RequestSeed = {
  agentId: "agent-research",
  topic: "EV registrations California",
  regions: ["US-CA"],
  dateRange: { start: "2024-01-01", end: "2026-09-30" },
  granularity: "monthly",
  requiredFields: ["brand", "units"],
  format: ["csv"],
  license: "company-use",
  freshness: { maxAgeDays: 90 },
  maxPriceAtomic: "7000000",
};

/** Agent B (finance) wants the United States, quarterly, 2025-2026. */
const FINANCE_NATIONAL: RequestSeed = {
  agentId: "agent-finance",
  topic: "EV registrations",
  regions: ["US"],
  dateRange: { start: "2025-01-01", end: "2026-09-30" },
  granularity: "quarterly",
  requiredFields: ["brand", "units"],
  format: ["csv"],
  license: "company-use",
  freshness: { maxAgeDays: 90 },
  maxPriceAtomic: "15000000",
};

describe("Fusion through POST /api/purchases/propose", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  let post: (path: string, body: unknown) => Promise<Response>;
  const session = { organizationId: "org-demo", principal: "owner" as const, ownerAddress: null };

  const mission = async (id: string, requests: RequestSeed[]): Promise<string[]> => {
    await handle.repos.missions.insert({ id, organizationId: "org-demo", goal: `fusion test ${id}`, budgetAtomic: "50000000", rootNodeId: 1, status: "active", createdAt: NOW });
    const ids: string[] = [];
    for (const [i, r] of requests.entries()) ids.push((await handle.repos.resourceRequests.insert({ ...r, id: `${id}-req-${i}`, missionId: id })).id);
    return ids;
  };

  beforeAll(async () => {
    handle = await testDatabase();
    await seedCatalog(handle.db);
    const orchestration = createOraclePort({ db: handle.db, model: null, treasury: TREASURY, orderTerms: simulatedOrderTerms, now: () => new Date(NOW) });
    const { app } = createApp({ db: handle.db, session, ports: { orchestration }, treasury: TREASURY });
    post = async (path, body) => app.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  });
  afterAll(() => handle.close());

  it("overlapping, compatible requests give one purchase with two allocations that sum to the price", async () => {
    const [reqA, reqB] = await mission("mission-f1", [RESEARCH_CALIFORNIA, FINANCE_NATIONAL]);
    const res = await post("/api/purchases/propose", { missionId: "mission-f1" });
    expect(res.status).toBe(201);
    const body = await json(res);

    // Oracle alone: A buys California (5 USDC), B buys the national set (12 USDC).
    expect(body.decisions.map((d: { requestId: string; chosen: string }) => [d.requestId, d.chosen])).toEqual([
      [reqA, CALIFORNIA],
      [reqB, NATIONAL],
    ]);

    // Fusion: the national monthly company-use set satisfies both; one 12 USDC purchase instead of 17.
    expect(body.merges).toHaveLength(1);
    const merge = body.merges[0];
    expect(merge).toMatchObject({ listingId: NATIONAL, merge: true, requestIds: [reqA, reqB], failingRules: [], waitingRequestIds: [], simulated: true });
    expect(merge.checks).toHaveLength(9);
    expect(merge.checks.every((c: { passed: boolean }) => c.passed)).toBe(true);
    expect(merge.checks.find((c: { rule: string }) => c.rule === "price").evidence).toContain("12.00 USDC vs 17.00 USDC separately");
    // research and finance share the orchestrator as parent; it has no onchain node yet, so the mission root pays.
    expect(merge.payer).toMatchObject({ agentId: null, nodeId: 1, rule: "mission-root" });

    expect(body.purchases).toHaveLength(1);
    const p = body.purchases[0];
    expect(p).toMatchObject({
      resourceId: NATIONAL,
      status: "PROPOSED",
      amountAtomic: "12000000",
      payingNodeId: 1,
      participatingAgentIds: ["agent-finance", "agent-research"],
      allocations: [
        { agentId: "agent-finance", department: "finance", amountAtomic: "8181818" },
        { agentId: "agent-research", department: "research", amountAtomic: "3818182" },
      ],
      txHashes: [],
    });
    expect(p.allocations.reduce((s: bigint, a: { amountAtomic: string }) => s + BigInt(a.amountAtomic), 0n)).toBe(12000000n);
    expect(p.authorizationDigest).toBeUndefined();

    // The merge is recorded as a purchase group and a fusion.decision event; nothing claims a payment.
    expect(p.purchaseGroupId).toBeDefined();
    const group = (await handle.repos.purchaseGroups.getById(p.purchaseGroupId))!;
    expect(group).toMatchObject({ missionId: "mission-f1", resourceId: NATIONAL, payingNodeId: 1, requestIds: [reqA, reqB] });
    expect(group.mergeReason).toMatch(/^Merge: all 9 rules pass/);
    const events = (await handle.repos.activityEvents.listRecent(20)).filter((e) => e.missionId === "mission-f1");
    const fusionEvents = events.filter((e) => e.kind === "fusion.decision");
    expect(fusionEvents).toHaveLength(1);
    expect(fusionEvents[0]!.message).toContain("mission root node 1 pays");
    expect(fusionEvents[0]!.simulated).toBe(true);
    expect(events.filter((e) => e.kind === "purchase.proposed")).toHaveLength(1);
    expect(await handle.repos.purchases.listByMission("mission-f1")).toHaveLength(1);
  });

  it("same topic, incompatible geography gives two separate decisions and no merge naming the rule", async () => {
    // Florida is not in any listing's state detail; Oregon-only finance request cannot share California's set.
    const [reqA, reqB] = await mission("mission-f2", [RESEARCH_CALIFORNIA, { ...FINANCE_NATIONAL, regions: ["US-OR"] }]);
    const res = await post("/api/purchases/propose", { missionId: "mission-f2" });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.decisions.map((d: { requestId: string; chosen: string | null }) => [d.requestId, d.chosen])).toEqual([
      [reqA, CALIFORNIA],
      [reqB, null],
    ]);
    expect(body.merges).toHaveLength(1);
    expect(body.merges[0]).toMatchObject({ listingId: CALIFORNIA, merge: false, payer: null });
    expect(body.merges[0].failingRules).toContain("geography");
    expect(body.merges[0].reason).toContain("geography (missing region(s) US-OR");
    expect(body.purchases).toHaveLength(1);
    expect(body.purchases[0]).toMatchObject({
      resourceId: CALIFORNIA,
      amountAtomic: "5000000",
      participatingAgentIds: ["agent-research"],
      allocations: [{ agentId: "agent-research", department: "research", amountAtomic: "5000000" }],
    });
    expect(body.purchases[0].purchaseGroupId).toBeUndefined();
  });

  it("the same single-user dataset chosen by two agents gives no merge: one purchase, the other request waits", async () => {
    // Topics do not overlap, so stage 1 proposes no pair; both pick the cheapest listing their license need allows.
    const single = { ...FINANCE_NATIONAL, license: "single-user" as const, maxPriceAtomic: "11000000" };
    const [reqA, reqB] = await mission("mission-f3", [
      { ...single, agentId: "agent-research", topic: "EV registrations" },
      { ...single, agentId: "agent-finance", topic: "Vehicle electrification fleet" },
    ]);
    const res = await post("/api/purchases/propose", { missionId: "mission-f3" });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.decisions.map((d: { chosen: string }) => d.chosen)).toEqual([SINGLE_USER, SINGLE_USER]);
    expect(body.merges).toHaveLength(1);
    expect(body.merges[0]).toMatchObject({ listingId: SINGLE_USER, merge: false, failingRules: ["license"], waitingRequestIds: [reqB] });
    expect(body.merges[0].reason).toContain("1 seat(s) for 2 agents");
    expect(body.purchases).toHaveLength(1);
    expect(body.purchases[0]).toMatchObject({
      resourceId: SINGLE_USER,
      participatingAgentIds: ["agent-research"],
      allocations: [{ agentId: "agent-research", department: "research", amountAtomic: "10000000" }],
    });
    expect((await handle.repos.resourceRequests.getById(reqA!))!.status).toBe("open");
    expect((await handle.repos.resourceRequests.getById(reqB!))!.status).toBe("open");
    const fusionEvent = (await handle.repos.activityEvents.listRecent(20)).find((e) => e.kind === "fusion.decision" && e.missionId === "mission-f3")!;
    expect(fusionEvent.message).toContain(`Request(s) ${reqB} wait`);
  });

  it("two concurrent buys give at most one purchase: same id, one row, one proposed event", async () => {
    await mission("mission-f4", [RESEARCH_CALIFORNIA, FINANCE_NATIONAL]);
    const [r1, r2] = await Promise.all([
      post("/api/purchases/propose", { missionId: "mission-f4" }),
      post("/api/purchases/propose", { missionId: "mission-f4" }),
    ]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    const [b1, b2] = await Promise.all([json(r1), json(r2)]);
    expect(b1.purchases).toHaveLength(1);
    expect(b2.purchases).toHaveLength(1);
    expect(b1.purchases[0].id).toBe(b2.purchases[0].id);
    const rows = await handle.repos.purchases.listByMission("mission-f4");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("PROPOSED");
    expect((await handle.repos.activityEvents.listByPurchase(rows[0]!.id)).filter((e) => e.kind === "purchase.proposed")).toHaveLength(1);
    expect(await handle.repos.purchaseGroups.listByMission("mission-f4")).toHaveLength(1);
  });
});
