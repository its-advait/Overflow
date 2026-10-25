import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureMissionAndResource, NOW, purchaseInput, testDatabase, TREASURY } from "../../test-db.js";
import { createApp } from "../app.js";

// Read routes behind the Purchases page: GET /api/missions and GET /api/missions/:id.
// Nothing here moves money; the routes only read what propose/authorize stored.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("GET /api/missions and GET /api/missions/:id", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  let get: (path: string) => Promise<Response>;
  const session = { organizationId: "org-demo", principal: "owner" as const, ownerAddress: null };

  beforeAll(async () => {
    handle = await testDatabase();
    const { mission } = await fixtureMissionAndResource(handle.repos);
    await handle.repos.organizations.insert({ id: "org-other", name: "Other Co (SIMULATED)", departments: ["ops"], simulated: true, createdAt: NOW });
    await handle.repos.missions.insert({
      id: "mission-other-org",
      organizationId: "org-other",
      goal: "not ours",
      budgetAtomic: "1000000",
      rootNodeId: 1,
      status: "draft",
      createdAt: NOW,
    });
    await handle.repos.resourceRequests.insert({
      id: "mission-1-req-0",
      missionId: mission.id,
      agentId: "agent-research",
      topic: "EV registrations",
      regions: ["United States"],
      dateRange: { start: "2024-01-01", end: "2026-09-30" },
      granularity: "monthly",
      requiredFields: ["brand", "units"],
      format: ["csv"],
      license: "company-use",
      freshness: { maxAgeDays: 90 },
      maxPriceAtomic: "15000000",
    });
    const group = await handle.repos.purchaseGroups.insert({
      id: "pg-1",
      missionId: mission.id,
      resourceId: "resource-1",
      payingNodeId: 1,
      requestIds: ["mission-1-req-0"],
      mergeReason: "Merge: all 9 rules pass for mission-1-req-0 on resource-1",
      createdAt: NOW,
    });
    await handle.repos.purchases.create(purchaseInput({ id: "purchase-1", purchaseGroupId: group.id, oracleReason: "cheapest covering listing" }));
    const { app } = createApp({ db: handle.db, session, treasury: TREASURY });
    get = (path) => Promise.resolve(app.request(path));
  });
  afterAll(() => handle.close());

  it("lists only the session organization's missions", async () => {
    const res = await get("/api/missions");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.missions.map((m: { id: string }) => m.id)).toEqual(["mission-1"]);
  });

  it("returns the mission with its requests, purchases (allocations included) and groups", async () => {
    const res = await get("/api/missions/mission-1");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.mission.id).toBe("mission-1");
    expect(body.requests.map((r: { id: string }) => r.id)).toEqual(["mission-1-req-0"]);
    expect(body.purchases).toHaveLength(1);
    expect(body.purchases[0]).toMatchObject({ id: "purchase-1", status: "PROPOSED", purchaseGroupId: "pg-1", oracleReason: "cheapest covering listing" });
    expect(body.purchases[0].allocations).toHaveLength(2);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({ id: "pg-1", requestIds: ["mission-1-req-0"], payingNodeId: 1 });
  });

  it("answers 404 for an unknown mission and for another organization's mission", async () => {
    for (const id of ["mission-nope", "mission-other-org"]) {
      const res = await get(`/api/missions/${id}`);
      expect(res.status).toBe(404);
      expect((await json(res)).error.code).toBe("not_found");
    }
  });
});
