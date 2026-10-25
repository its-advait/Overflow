import type { ResourceRequestRecord } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedCatalog } from "../../orchestration/catalog.js";
import { createOraclePort } from "../../orchestration/oracle-port.js";
import { fakeRecourseSeller } from "../../orchestration/seller-order-terms.test-util.js";
import { createSellerOrderTerms } from "../../orchestration/seller-order-terms.js";
import { NOW, SELLER, testDatabase, TREASURY } from "../../test-db.js";
import { createApp } from "../app.js";

// POST /api/purchases/propose with the real seller-backed OrderTermsPort over a fake SIMULATED seller
// (`fetch`) and fake factory reads: the purchase carries the seller's escrow and an escrow_orders row is
// written in the same transaction and readable via GET /api/escrow/:purchaseId.

const JSON_HEADERS = { "content-type": "application/json" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json() as Promise<any>;
const NATIONAL = "listing-national-monthly-2024-2026";

const REQUEST: Omit<ResourceRequestRecord, "id" | "createdAt" | "status" | "missionId"> = {
  agentId: "agent-research",
  topic: "EV registrations",
  regions: ["US"],
  dateRange: { start: "2024-01-01", end: "2026-09-30" },
  granularity: "monthly",
  requiredFields: ["brand", "units", "state"],
  format: ["csv"],
  license: "company-use",
  freshness: { maxAgeDays: 90 },
  maxPriceAtomic: "15000000",
};

describe("propose with the seller-backed OrderTermsPort", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  let seller: ReturnType<typeof fakeRecourseSeller>;
  let app: ReturnType<typeof createApp>["app"];
  const session = { organizationId: "org-demo", principal: "owner" as const, ownerAddress: null };
  const now = () => new Date(NOW);
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

  beforeAll(async () => {
    handle = await testDatabase();
    await seedCatalog(handle.db);
    seller = fakeRecourseSeller({
      now,
      listing: async (id) => {
        const r = await handle.repos.resources.getById(id);
        return r ? { priceAtomic: r.priceAtomic, manifestHash: r.manifestHash } : undefined;
      },
    });
    const orderTerms = createSellerOrderTerms({ sellerUrl: "http://seller.test", fetch: seller.fetch, reads: seller.reads, treasury: TREASURY, now });
    const orchestration = createOraclePort({ db: handle.db, model: null, treasury: TREASURY, orderTerms, now });
    app = createApp({ db: handle.db, session, ports: { orchestration }, treasury: TREASURY }).app;
    await handle.repos.missions.insert({ id: "mission-s1", organizationId: "org-demo", goal: "seller terms test", budgetAtomic: "50000000", rootNodeId: 1, status: "active", createdAt: NOW });
    await handle.repos.resourceRequests.insert({ ...REQUEST, id: "mission-s1-req-0", missionId: "mission-s1" });
  });
  afterAll(() => handle.close());

  it("writes the purchase with the seller's escrow and an escrow_orders row readable via GET /api/escrow/:purchaseId", async () => {
    const res = await post("/api/purchases/propose", { missionId: "mission-s1" });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(seller.calls).toEqual([{ resourceId: NATIONAL, buyerTreasury: TREASURY, missionId: "mission-s1" }]);
    expect(body.purchases).toHaveLength(1);
    const p = body.purchases[0];
    const national = (await handle.repos.resources.getById(NATIONAL))!;
    expect(p).toMatchObject({ missionId: "mission-s1", resourceId: NATIONAL, status: "PROPOSED", amountAtomic: "12000000", sellerAddress: SELLER, buyerTreasury: TREASURY, resourceManifestHash: national.manifestHash });
    // The escrow address is the fake factory's prediction for the recomputed (orderId, termsHash), not a placeholder.
    expect(seller.created.has(p.escrowAddress.toLowerCase())).toBe(true);
    expect(await seller.reads.predict(p.orderIdBytes32, p.termsHash)).toBe(p.escrowAddress);

    const esc = await app.request(`/api/escrow/${p.id}`);
    expect(esc.status).toBe(200);
    const { escrow, chainTransactions } = await json(esc);
    expect(escrow).toMatchObject({
      purchaseId: p.id,
      orderIdBytes32: p.orderIdBytes32,
      escrowAddress: p.escrowAddress,
      sellerAddress: SELLER,
      amountAtomic: "12000000",
      bondAtomic: "2400000",
      termsHash: p.termsHash,
      manifestHash: national.manifestHash,
      challengeWindow: "300",
      status: "Created", // funding is only ever set from a confirmed chain event
    });
    expect(escrow.revealedKey).toBeUndefined();
    expect(chainTransactions).toEqual([]);
    const byAddress = await app.request(`/api/escrow/${p.escrowAddress}`);
    expect((await json(byAddress)).escrow.id).toBe(escrow.id);

    // Idempotent replay: same purchase, still one escrow row, no second seller order needed to answer.
    const again = await json(await post("/api/purchases/propose", { missionId: "mission-s1" }));
    expect(again.purchases[0].id).toBe(p.id);
    expect(await handle.repos.escrowOrders.listAll()).toHaveLength(1);
  });

  it("a seller whose terms fail verification: 502 seller_terms_rejected and nothing written", async () => {
    await handle.repos.missions.insert({ id: "mission-s2", organizationId: "org-demo", goal: "bad seller", budgetAtomic: "50000000", rootNodeId: 1, status: "active", createdAt: NOW });
    await handle.repos.resourceRequests.insert({ ...REQUEST, id: "mission-s2-req-0", missionId: "mission-s2" });
    const bad = fakeRecourseSeller({ now, listing: () => ({ priceAtomic: "12000000", manifestHash: "0x" + "ab".repeat(32) as `0x${string}` }) });
    const orderTerms = createSellerOrderTerms({ sellerUrl: "http://seller.test", fetch: bad.fetch, reads: bad.reads, treasury: TREASURY, now });
    const orchestration = createOraclePort({ db: handle.db, model: null, treasury: TREASURY, orderTerms, now });
    const badApp = createApp({ db: handle.db, session, ports: { orchestration }, treasury: TREASURY }).app;
    const res = await badApp.request("/api/purchases/propose", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ missionId: "mission-s2" }) });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error.code).toBe("seller_terms_rejected");
    expect(body.error.details.reason).toMatch(/manifestHash/);
    expect(await handle.repos.purchases.listByMission("mission-s2")).toEqual([]);
    expect(await handle.repos.escrowOrders.listAll()).toHaveLength(1);
  });
});
