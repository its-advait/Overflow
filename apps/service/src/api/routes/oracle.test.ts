import type { ExtractionClient } from "@overflow/oracle";
import { computeOrderId } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedCatalog } from "../../orchestration/catalog.js";
import { createOraclePort, notWiredOrderTerms, type OracleModel, type OrderTermsPort } from "../../orchestration/oracle-port.js";
import { b32, ESCROW, NOW, SELLER, testDatabase, TREASURY } from "../../test-db.js";
import { createApp } from "../app.js";

const JSON_HEADERS = { "content-type": "application/json" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json() as Promise<any>;
const MODEL = "fake-model-for-tests";
const NATIONAL = "listing-national-monthly-2024-2026";

/** Fake Anthropic client: scripted outputs, no network (same shape as packages/oracle/src/extract.test.ts). */
function fakeClient(outputs: Array<unknown>): { model: OracleModel; calls: number } {
  const state = { calls: 0 };
  const parse = async () => {
    state.calls++;
    const next = outputs.shift();
    if (next === undefined) throw new Error("fake client: no scripted output left");
    const scripted = next as { text?: string };
    const raw = typeof scripted.text === "string" ? scripted.text : JSON.stringify(next);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    return {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: MODEL,
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      content: [{ type: "text", text: raw, citations: null, parsed_output: parsed }],
      usage: { input_tokens: 1, output_tokens: 1 },
      parsed_output: parsed,
    };
  };
  const client = { messages: { parse } } as unknown as ExtractionClient;
  return {
    model: { client, model: MODEL },
    get calls() {
      return state.calls;
    },
  };
}

/** SIMULATED order terms: a fixed seller and escrow, termsHash b32(9); the orderId is computed from fixed ABI fields. */
function simulatedOrderTerms(): { port: OrderTermsPort; calls: number } {
  const state = { calls: 0 };
  return {
    port: {
      async prepare(input) {
        state.calls++;
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
    },
    get calls() {
      return state.calls;
    },
  };
}

const GOOD_OUTPUT = {
  requests: [
    {
      topic: "EV registrations",
      regions: ["US"],
      dateRange: { start: "2024-01-01", end: "2026-12-31" },
      granularity: "monthly",
      requiredFields: ["Brand", "units", "state"],
      format: ["csv"],
      license: "company-use",
      freshnessMaxAgeDays: 90,
      maxPriceUsdc: "15",
    },
  ],
  assumptions: ["national means the US aggregate"],
};

describe("Oracle routes: plan and propose", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  const session = { organizationId: "org-demo", principal: "owner" as const, ownerAddress: null };
  const now = () => new Date(NOW);

  const appWith = (opts: { outputs?: unknown[]; treasury?: typeof TREASURY | null; orderTerms?: OrderTermsPort; model?: OracleModel | null }) => {
    const fake = fakeClient(opts.outputs ?? []);
    const terms = simulatedOrderTerms();
    const model = opts.model === undefined ? fake.model : opts.model;
    const orchestration = createOraclePort({
      db: handle.db,
      model,
      treasury: opts.treasury === undefined ? TREASURY : opts.treasury,
      orderTerms: opts.orderTerms ?? terms.port,
      now,
    });
    const { app } = createApp({ db: handle.db, session, ports: { orchestration }, treasury: TREASURY });
    const post = (path: string, body: unknown) =>
      app.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    return { app, post, fake, terms };
  };

  beforeAll(async () => {
    handle = await testDatabase();
    await seedCatalog(handle.db);
    await handle.repos.missions.insert({
      id: "mission-1",
      organizationId: "org-demo",
      goal: "Monthly US EV registrations 2024-2026 with brand and units per state, CSV, for the research team",
      budgetAtomic: "50000000",
      rootNodeId: 1,
      status: "active",
      createdAt: NOW,
    });
  });
  afterAll(() => handle.close());

  it("GET /api/resources shows the seeded SIMULATED catalog", async () => {
    const { app } = appWith({});
    const { resources, filtered } = await json(await app.request("/api/resources"));
    expect(resources).toHaveLength(6);
    expect(resources.every((r: { simulated: boolean }) => r.simulated)).toBe(true);
    expect(filtered).toBe(false);
  });

  it("propose before plan: 409 no_open_requests, nothing written", async () => {
    const { post } = appWith({});
    const res = await post("/api/purchases/propose", { missionId: "mission-1" });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("no_open_requests");
    expect(await handle.repos.purchases.listByMission("mission-1")).toEqual([]);
  });

  it("plan without a model: 503 oracle_unavailable, mission untouched", async () => {
    const { post, fake } = appWith({ model: null });
    const res = await post("/api/missions/mission-1/plan", {});
    expect(res.status).toBe(503);
    expect((await json(res)).error.code).toBe("oracle_unavailable");
    expect(fake.calls).toBe(0);
    expect((await handle.repos.missions.getById("mission-1"))!.status).toBe("active");
    expect(await handle.repos.resourceRequests.listByMission("mission-1")).toEqual([]);
  });

  it("plan with two invalid model outputs: 502 oracle_extraction_failed, both calls audited, no requests", async () => {
    const { post, fake } = appWith({ outputs: [{ text: "not json" }, { text: "still not json" }] });
    const res = await post("/api/missions/mission-1/plan", {});
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error.code).toBe("oracle_extraction_failed");
    expect(body.error.details.modelCalls).toHaveLength(2);
    expect(fake.calls).toBe(2);
    const audit = (await handle.repos.activityEvents.listRecent(10)).filter((e) => e.kind === "oracle.model_call");
    expect(audit).toHaveLength(2);
    expect(await handle.repos.resourceRequests.listByMission("mission-1")).toEqual([]);
    expect((await handle.repos.missions.getById("mission-1"))!.status).toBe("active");
  });

  it("plan: extracts, clamps, persists the requests for the orchestrator and marks the mission planning", async () => {
    const { post, fake } = appWith({ outputs: [GOOD_OUTPUT] });
    const res = await post("/api/missions/mission-1/plan", {});
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(fake.calls).toBe(1);
    expect(body.mission.status).toBe("planning");
    expect(body.requests).toHaveLength(1);
    const r = body.requests[0];
    expect(r).toMatchObject({
      missionId: "mission-1",
      agentId: "agent-orchestrator",
      status: "open",
      regions: ["US"],
      dateRange: { start: "2024-01-01", end: "2026-09-30" }, // clamped to the last complete month before NOW
      granularity: "monthly",
      requiredFields: ["brand", "units", "state"],
      license: "company-use",
      maxPriceAtomic: "15000000",
    });
    const stored = await handle.repos.resourceRequests.listByMission("mission-1");
    expect(stored.map((s) => s.id)).toEqual([r.id]);
  });

  it("re-plan withdraws the earlier open requests instead of duplicating them", async () => {
    const before = await handle.repos.resourceRequests.listByMission("mission-1");
    const { post } = appWith({ outputs: [GOOD_OUTPUT] });
    const res = await post("/api/missions/mission-1/plan", {});
    expect(res.status).toBe(200);
    const after = await handle.repos.resourceRequests.listByMission("mission-1");
    expect(after).toHaveLength(2);
    expect(after.find((s) => s.id === before[0]!.id)!.status).toBe("withdrawn");
    expect(after.filter((s) => s.status === "open")).toHaveLength(1);
  });

  it("while planning: propose and run answer 409 requirements_unconfirmed; the owner edits one requirement; confirm locks it", async () => {
    const { app, post } = appWith({});
    const blocked = await post("/api/purchases/propose", { missionId: "mission-1" });
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error.code).toBe("requirements_unconfirmed");
    const run = await post("/api/missions/mission-1/run", {});
    expect(run.status).toBe(409);
    expect((await json(run)).error.code).toBe("requirements_unconfirmed");

    const open = (await handle.repos.resourceRequests.listByMission("mission-1")).find((r) => r.status === "open")!;
    const { id: _id, missionId: _m, agentId: _a, status: _s, createdAt: _c, ...fields } = open;
    void _id; void _m; void _a; void _s; void _c;
    const put = (requestId: string, body: unknown) =>
      app.request(`/api/missions/mission-1/requests/${requestId}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });

    const overBudget = await put(open.id, { ...fields, maxPriceAtomic: "50000001" });
    expect(overBudget.status).toBe(409);
    expect((await json(overBudget)).error.code).toBe("over_budget");

    const edited = await put(open.id, { ...fields, topic: "EV registrations by brand", regions: ["US"] });
    expect(edited.status).toBe(200);
    const body = await json(edited);
    expect(body.request).toMatchObject({ id: open.id, topic: "EV registrations by brand", regions: ["US"], status: "open", agentId: open.agentId });
    expect((await handle.repos.resourceRequests.getById(open.id))!.topic).toBe("EV registrations by brand");

    const withdrawn = (await handle.repos.resourceRequests.listByMission("mission-1")).find((r) => r.status === "withdrawn")!;
    expect((await put(withdrawn.id, fields)).status).toBe(409);
    expect((await put("req-nope", fields)).status).toBe(404);

    const confirmed = await post("/api/missions/mission-1/confirm", {});
    expect(confirmed.status).toBe(200);
    expect((await json(confirmed)).mission.status).toBe("confirmed");
    expect((await handle.repos.missions.getById("mission-1"))!.status).toBe("confirmed");
    const again = await post("/api/missions/mission-1/confirm", {});
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe("not_planning");
    expect((await put(open.id, fields)).status).toBe(409);
    expect((await json(await put(open.id, fields))).error.code).toBe("not_editable");

    const kinds = (await handle.repos.activityEvents.listRecent(10)).map((e) => e.kind);
    expect(kinds).toContain("mission.requirement_edited");
    expect(kinds).toContain("mission.confirmed");
  });

  it("propose with order terms not wired: 501 naming the seller step; the decision is recorded, no purchase row", async () => {
    const { post, fake } = appWith({ orderTerms: notWiredOrderTerms() });
    const res = await post("/api/purchases/propose", { missionId: "mission-1" });
    expect(res.status).toBe(501);
    const body = await json(res);
    expect(body.error.code).toBe("not_wired");
    expect(body.error.details.port).toMatch(/OrderTermsPort/);
    expect(fake.calls).toBe(0); // recommend never calls the model
    expect(await handle.repos.purchases.listByMission("mission-1")).toEqual([]);
    const rec = (await handle.repos.activityEvents.listRecent(5)).filter((e) => e.kind === "oracle.recommendation");
    expect(rec).toHaveLength(1);
    expect(rec[0]!.message).toContain(`chose ${NATIONAL}`);
    expect(rec[0]!.simulated).toBe(true);
  });

  it("propose without a treasury address: 501, no address invented", async () => {
    const { post } = appWith({ treasury: null });
    const res = await post("/api/purchases/propose", { missionId: "mission-1" });
    expect(res.status).toBe(501);
    expect((await json(res)).error.details.port).toMatch(/treasury/);
    expect(await handle.repos.purchases.listByMission("mission-1")).toEqual([]);
  });

  it("propose: Oracle picks the 12 USDC national set, explains every rejection, and a PROPOSED row is persisted once", async () => {
    const { post, terms } = appWith({});
    const res = await post("/api/purchases/propose", { missionId: "mission-1" });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(terms.calls).toBe(1);

    expect(body.decisions).toHaveLength(1);
    expect(body.merges).toEqual([]); // one request: nothing to fuse
    const decision = body.decisions[0];
    expect(decision.chosen).toBe(NATIONAL);
    expect(decision.alternatives).toEqual(["listing-national-monthly-2024-2026-seller-b"]);
    const reasons = Object.fromEntries(
      decision.rejected.map((r: { listingId: string; reasons: { reason: string }[] }) => [r.listingId, r.reasons.map((x) => x.reason)]),
    );
    expect(reasons).toEqual({
      "listing-california-monthly-2024-2026": ["region"],
      "listing-national-annual-2024-2026": ["granularity"],
      "listing-national-monthly-2021-2022": ["dateRange"],
      "listing-national-monthly-2024-2026-single-user": ["license"],
    });
    expect(decision.summary).toMatch(/authorizes no payment\.$/);
    expect(decision.simulated).toBe(true);

    expect(body.purchases).toHaveLength(1);
    const p = body.purchases[0];
    expect(p).toMatchObject({
      missionId: "mission-1",
      resourceId: NATIONAL,
      status: "PROPOSED",
      amountAtomic: "12000000",
      buyerTreasury: TREASURY,
      sellerAddress: SELLER,
      escrowAddress: ESCROW,
      termsHash: b32(9),
      payingNodeId: 1, // the orchestrator has no onchain node yet: the mission root pays
      participatingAgentIds: ["agent-orchestrator"],
      allocations: [{ agentId: "agent-orchestrator", department: "research", amountAtomic: "12000000" }],
      paymentPath: "overflow-facilitator",
      txHashes: [],
    });
    expect(p.authorizationDigest).toBeUndefined();
    expect(p.oracleReason).toMatch(/authorizes no payment/);
    const national = (await handle.repos.resources.getById(NATIONAL))!;
    expect(p.resourceManifestHash).toBe(national.manifestHash);

    const events = await handle.repos.activityEvents.listByPurchase(p.id);
    expect(events.map((e) => e.kind)).toEqual(["purchase.proposed"]);
    expect(events[0]!.simulated).toBe(true);
    expect(events[0]!.message).toMatch(/\[oracle:/);

    // Idempotent: the same open requests resolve to the same purchase; nothing new is written.
    const again = await post("/api/purchases/propose", { missionId: "mission-1" });
    expect(again.status).toBe(201);
    const body2 = await json(again);
    expect(body2.purchases).toHaveLength(1);
    expect(body2.purchases[0].id).toBe(p.id);
    expect(await handle.repos.activityEvents.listByPurchase(p.id)).toHaveLength(1);
    expect(await handle.repos.purchases.listByMission("mission-1")).toHaveLength(1);
  });

  it("propose when every listing is rejected: 201 with no purchases and the decision explaining why", async () => {
    await handle.repos.missions.insert({
      id: "mission-2",
      organizationId: "org-demo",
      goal: "EV registrations for Germany",
      budgetAtomic: "50000000",
      rootNodeId: 1,
      status: "active",
      createdAt: NOW,
    });
    const { post, terms } = appWith({
      outputs: [{ ...GOOD_OUTPUT, requests: [{ ...GOOD_OUTPUT.requests[0], regions: ["DE"] }] }],
    });
    expect((await post("/api/missions/mission-2/plan", {})).status).toBe(200);
    expect((await post("/api/missions/mission-2/confirm", {})).status).toBe(200); // the owner reviews before anything is proposed
    const res = await post("/api/purchases/propose", { missionId: "mission-2" });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.purchases).toEqual([]);
    expect(body.decisions[0].chosen).toBeNull();
    expect(body.decisions[0].rejected).toHaveLength(6);
    expect(body.decisions[0].rejected.every((r: { reasons: { reason: string }[] }) => r.reasons.some((x) => x.reason === "region"))).toBe(true);
    expect(terms.calls).toBe(0);
    expect(await handle.repos.purchases.listByMission("mission-2")).toEqual([]);
  });
});
