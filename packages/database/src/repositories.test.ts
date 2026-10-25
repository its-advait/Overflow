import {
  ActivityEventSchema,
  AgentRecordSchema,
  ControllerRequestSchema,
  EscrowOrderSchema,
  ExceptionRecordSchema,
  MissionRecordSchema,
  OrganizationSchema,
  PurchaseGroupSchema,
  ReservationRecordSchema,
  ResourceRecordSchema,
  ResourceRequestRecordSchema,
  SampleRecordSchema,
  SellerHistorySchema,
} from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UniqueViolationError } from "./errors";
import { InvalidEscrowTransitionError } from "./repositories";
import { ADDR, ADDR2, B32, b32, freshDatabase, purchaseInput, seedFixture } from "./test-helpers";

describe("repositories return Zod-validated rows", () => {
  let handle: Awaited<ReturnType<typeof freshDatabase>>;
  let fixture: Awaited<ReturnType<typeof seedFixture>>;
  let purchaseId: string;
  beforeAll(async () => {
    handle = await freshDatabase();
    fixture = await seedFixture(handle.repos);
    purchaseId = (await handle.repos.purchases.create(purchaseInput())).id;
  });
  afterAll(() => handle.close());

  it("organizations, agents, missions, resources", async () => {
    const { organizations, agents, missions, resources } = handle.repos;
    expect(OrganizationSchema.safeParse(await organizations.getById("org-test")).success).toBe(true);
    expect(AgentRecordSchema.safeParse(await agents.getByKey(ADDR)).success).toBe(true);
    const withNode = await agents.setNodeId("agent-research", 2);
    expect(withNode?.nodeId).toBe(2);
    expect(MissionRecordSchema.safeParse(await missions.getById("mission-1")).success).toBe(true);
    expect((await missions.setStatus("mission-1", "complete"))?.status).toBe("complete");
    const r = await resources.getById("resource-1");
    expect(ResourceRecordSchema.safeParse(r).success).toBe(true);
    expect(r?.priceAtomic).toBe("12000000");
    expect(r?.simulated).toBe(true);
  });

  it("resource requests and purchase groups", async () => {
    const { resourceRequests, purchaseGroups } = handle.repos;
    const req = await resourceRequests.insert({
      missionId: "mission-1",
      agentId: fixture.research.id,
      topic: "EV registrations",
      regions: ["California"],
      dateRange: { start: "2024-01-01", end: "2026-12-31" },
      granularity: "monthly",
      requiredFields: ["brand", "units"],
      format: ["csv"],
      license: "company-use",
      freshness: { maxAgeDays: 90 },
      maxPriceAtomic: "15000000",
    });
    expect(ResourceRequestRecordSchema.safeParse(req).success).toBe(true);
    expect(req.status).toBe("open");
    expect((await resourceRequests.setStatus(req.id, "matched"))?.status).toBe("matched");
    const group = await purchaseGroups.insert({
      missionId: "mission-1",
      resourceId: "resource-1",
      payingNodeId: 1,
      requestIds: [req.id],
      mergeReason: "single request",
    });
    expect(PurchaseGroupSchema.safeParse(group).success).toBe(true);
    expect((await purchaseGroups.listByMission("mission-1")).length).toBe(1);
  });

  it("escrow orders follow the contract's status machine", async () => {
    const { escrowOrders } = handle.repos;
    const order = await escrowOrders.insert({
      purchaseId,
      orderIdBytes32: b32(1),
      escrowAddress: ADDR2,
      sellerAddress: ADDR2,
      amountAtomic: "12000000",
      bondAtomic: "2400000",
      termsHash: b32(9),
      manifestHash: B32,
      rootPlain: b32(11),
      rootCipher: b32(12),
      keyCommitment: b32(13),
      revealDeadline: "1800000000",
      challengeWindow: "600",
      sourceKey: ADDR,
      minTimestamp: "0",
    });
    expect(EscrowOrderSchema.safeParse(order).success).toBe(true);
    expect(order.status).toBe("Created");
    await expect(escrowOrders.setStatus(purchaseId, "Settled")).rejects.toBeInstanceOf(InvalidEscrowTransitionError);
    expect((await escrowOrders.setStatus(purchaseId, "Funded")).status).toBe("Funded");
    const revealed = await escrowOrders.setStatus(purchaseId, "Revealed", { revealedKey: b32(42) });
    expect(revealed.revealedKey).toBe(b32(42));
    expect((await escrowOrders.listOpen()).length).toBe(1);
    expect((await escrowOrders.setStatus(purchaseId, "Settled")).status).toBe("Settled");
    await expect(escrowOrders.setStatus(purchaseId, "Refunded")).rejects.toBeInstanceOf(InvalidEscrowTransitionError);
    expect((await escrowOrders.listOpen()).length).toBe(0);
    // One escrow per purchase.
    await expect(escrowOrders.insert({ ...order, id: "other", escrowAddress: ADDR })).rejects.toBeInstanceOf(
      UniqueViolationError,
    );
  });

  it("reservations are unique per digest and move active -> consumed | released", async () => {
    const { reservations } = handle.repos;
    const res = await reservations.insert({
      digest: b32(500),
      purchaseId,
      nodeId: 2,
      valueAtomic: "5000000",
      validBefore: "1800000000",
      nonce: b32(501),
    });
    expect(ReservationRecordSchema.safeParse(res).success).toBe(true);
    expect(res.status).toBe("active");
    await expect(
      reservations.insert({ digest: b32(500), nodeId: 2, valueAtomic: "1", validBefore: "1", nonce: b32(502) }),
    ).rejects.toBeInstanceOf(UniqueViolationError);
    expect((await reservations.markReleased(b32(500), b32(503))).status).toBe("released");
    expect((await reservations.listActive()).length).toBe(0);
  });

  it("samples, seller history, exceptions, controller requests, activity events", async () => {
    const { samples, sellerHistory, exceptions, controllerRequests, activityEvents } = handle.repos;

    const sample = await samples.insert({
      purchaseId,
      indices: [3, 17, 42],
      verdict: "buy",
      reason: "fields present, dates in range",
      confidence: 0.92,
      promptHash: b32(7),
      outputHash: b32(8),
    });
    expect(SampleRecordSchema.safeParse(sample).success).toBe(true);
    expect(sample.confidence).toBe(0.92);

    const h1 = await sellerHistory.upsertIncrement(ADDR2, { sellerId: "seller-honest", orders: 1, onTimeReveals: 1 });
    const h2 = await sellerHistory.upsertIncrement(ADDR2, { orders: 1, provenCheats: 1 });
    expect(SellerHistorySchema.safeParse(h2).success).toBe(true);
    expect(h1.flagged).toBe(false);
    expect(h2).toMatchObject({ orders: 2, onTimeReveals: 1, provenCheats: 1, flagged: true, sellerId: "seller-honest" });
    expect((await sellerHistory.listFlagged()).map((s) => s.sellerAddress)).toEqual([ADDR2]);

    const ex = await exceptions.open({
      type: "RECONCILIATION_DIFF",
      reason: "ledger differs from chain by 0.50 USDC (planted)",
      amountAtomic: "500000",
      purchaseId,
    });
    expect(ExceptionRecordSchema.safeParse(ex).success).toBe(true);
    expect((await exceptions.listOpen()).length).toBe(1);
    const resolved = await exceptions.resolve(ex.id, "controller");
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedBy).toBe("controller");

    const cr = await controllerRequests.insert({
      action: { kind: "raise-cap", nodeId: 2, newCapAtomic: "100000000" },
      requestedBy: fixture.research.id,
      reason: "mission needs more budget",
      target: ADDR2,
      data: "0xdeadbeef",
      value: "0",
      summary: "raiseCap(2, 100000000)",
    });
    expect(ControllerRequestSchema.safeParse(cr).success).toBe(true);
    await expect(controllerRequests.resolve(cr.id, "done")).rejects.toThrow(/txHash/);
    expect((await controllerRequests.resolve(cr.id, "done", b32(900))).txHash).toBe(b32(900));
    expect((await controllerRequests.listPending()).length).toBe(0);

    const ev = await activityEvents.insert({
      kind: "policy.blocked",
      message: "Treasury rejected payment",
      purchaseId,
      agentId: fixture.research.id,
      decodedRevert: "OverBudget(3)",
      simulated: true,
    });
    expect(ActivityEventSchema.safeParse(ev).success).toBe(true);
    expect((await activityEvents.listRecent())[0]?.id).toBe(ev.id);
    expect((await activityEvents.listByPurchase(purchaseId)).length).toBe(1);
  });
});
