import { InvalidTransitionError } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { b32, fixtureMissionAndResource, purchaseInput, testDatabase } from "../test-db.js";
import { createPurchaseService, TransitionEvidenceError } from "./purchase-service.js";

describe("PurchaseService", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  let service: ReturnType<typeof createPurchaseService>;
  beforeAll(async () => {
    handle = await testDatabase();
    await fixtureMissionAndResource(handle.repos);
    service = createPurchaseService(handle.db);
  });
  afterAll(() => handle.close());

  it("propose creates a PROPOSED row and one purchase.proposed event", async () => {
    const { purchase, event } = await service.propose({
      purchase: purchaseInput({ id: "p1" }),
      reason: "Oracle ranked it first; Fusion merged two requests",
      source: { kind: "oracle", reference: "test" },
      agentId: "agent-research",
    });
    expect(purchase.status).toBe("PROPOSED");
    expect(event.kind).toBe("purchase.proposed");
    expect(event.purchaseId).toBe("p1");
    expect(event.message).toContain("[oracle:test]");
    expect(await handle.repos.activityEvents.listByPurchase("p1")).toHaveLength(1);

    // Same idempotencyKey again: the stored purchase and its original event come back, nothing is written.
    const replay = await service.propose({
      purchase: purchaseInput({ id: "p1-again", idempotencyKey: "mission-1:resource-1:p1" }),
      reason: "repeat",
      source: { kind: "oracle", reference: "test-2" },
    });
    expect(replay.replayed).toBe(true);
    expect(replay.purchase.id).toBe("p1");
    expect(replay.event.id).toBe(event.id);
    expect(await handle.repos.activityEvents.listByPurchase("p1")).toHaveLength(1);
  });

  it("a legal move writes exactly one event carrying the reason and source", async () => {
    const { purchase, event } = await service.transition("p1", "RESERVED", {
      reason: "signed",
      source: { kind: "adapter", reference: "overflow-facilitator" },
      authorizationDigest: b32(42),
    });
    expect(purchase.status).toBe("RESERVED");
    expect(purchase.authorizationDigest).toBe(b32(42));
    expect(event.kind).toBe("payment.authorized");
    expect(event.message).toBe("PROPOSED -> RESERVED: signed [adapter:overflow-facilitator]");
    expect(await handle.repos.activityEvents.listByPurchase("p1")).toHaveLength(2);
  });

  it("an illegal move throws InvalidTransitionError and writes nothing", async () => {
    await expect(
      service.transition("p1", "SETTLED", { reason: "x", source: { kind: "chain", reference: b32(1) }, txHash: b32(1) }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    expect((await handle.repos.purchases.getById("p1"))!.status).toBe("RESERVED");
    expect(await handle.repos.activityEvents.listByPurchase("p1")).toHaveLength(2);
  });

  it("PAYMENT_PENDING needs the digest; ESCROW_FUNDED needs a chain txHash from the chain", async () => {
    await expect(
      service.transition("p1", "PAYMENT_PENDING", { reason: "x", source: { kind: "api", reference: "r" } }),
    ).rejects.toBeInstanceOf(TransitionEvidenceError);
    await service.transition("p1", "PAYMENT_PENDING", {
      reason: "submitting",
      source: { kind: "adapter", reference: "overflow-facilitator" },
      authorizationDigest: b32(42),
    });
    await expect(
      service.transition("p1", "ESCROW_FUNDED", { reason: "x", source: { kind: "chain", reference: "indexer" } }),
    ).rejects.toThrow(/txHash/);
    await expect(
      service.transition("p1", "ESCROW_FUNDED", { reason: "x", source: { kind: "api", reference: "r" }, txHash: b32(7) }),
    ).rejects.toThrow(/chain or reconciliation/);
    const funded = await service.transition("p1", "ESCROW_FUNDED", {
      reason: "OrderFunded event",
      source: { kind: "chain", reference: b32(7) },
      txHash: b32(7),
    });
    expect(funded.purchase.status).toBe("ESCROW_FUNDED");
    expect(funded.purchase.txHashes).toEqual([b32(7)]);
    expect(funded.event.kind).toBe("escrow.funded");
    expect(funded.event.txHash).toBe(b32(7));
  });

  it("REJECTED stores the decoded revert for the Blocked lane", async () => {
    await service.propose({
      purchase: purchaseInput({ id: "p2", orderIdBytes32: b32(2), resourceId: "resource-1", missionId: "mission-1", idempotencyKey: "k-p2" }),
      reason: "second",
      source: { kind: "oracle", reference: "test" },
    }).catch(() => undefined); // p1 is still active for (mission-1, resource-1); p2 may be refused
    const r2 = await handle.repos.resources.insert({
      id: "resource-2",
      title: "Other (SIMULATED)",
      sellerId: "seller-honest",
      productId: "x",
      coverage: { regions: ["US"], dateRange: { start: "2024-01-01", end: "2024-12-31" }, granularity: "monthly", fields: ["a"], format: "csv" },
      license: "company-use",
      priceAtomic: "12000000",
      manifestHash: b32(6),
      seats: 1,
      simulated: true,
    });
    const { purchase } = await service.propose({
      purchase: purchaseInput({ id: "p3", orderIdBytes32: b32(3), resourceId: r2.id, idempotencyKey: "k-p3" }),
      reason: "third",
      source: { kind: "oracle", reference: "test" },
    });
    await expect(
      service.transition(purchase.id, "REJECTED", { reason: "x", source: { kind: "adapter", reference: "a" } }),
    ).rejects.toBeInstanceOf(TransitionEvidenceError);
    const { event } = await service.transition(purchase.id, "REJECTED", {
      reason: "treasury reverted",
      source: { kind: "adapter", reference: "overflow-facilitator" },
      decodedRevert: "OverBudget(3)",
    });
    expect(event.kind).toBe("policy.blocked");
    expect(event.decodedRevert).toBe("OverBudget(3)");
  });

  it("a second active purchase for the same (mission, resource) is refused", async () => {
    await expect(
      service.propose({
        purchase: purchaseInput({ id: "p4", orderIdBytes32: b32(4), idempotencyKey: "k-p4" }),
        reason: "dup",
        source: { kind: "oracle", reference: "test" },
      }),
    ).rejects.toThrow(/active purchase already exists/);
  });
});
