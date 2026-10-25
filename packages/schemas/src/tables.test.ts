import { describe, expect, it } from "vitest";
import {
  AgentRecordSchema,
  ChainTransactionSchema,
  ESCROW_TRANSITIONS,
  EscrowOrderSchema,
  FinancialEntrySchema,
  MissionRecordSchema,
  OrganizationSchema,
  PurchaseGroupSchema,
  PurchaseRecordSchema,
  ReservationRecordSchema,
  ResourceRecordSchema,
  ResourceRequestRecordSchema,
  SampleRecordSchema,
  SellerHistorySchema,
} from "./index";

const ADDR = "0x1111111111111111111111111111111111111111";
const B32 = `0x${"22".repeat(32)}`;
const NOW = "2026-10-24T16:00:00Z";

describe("table row schemas", () => {
  it("parses one valid row per schema", () => {
    expect(
      OrganizationSchema.parse({
        id: "org",
        name: "FICTIONAL Co",
        departments: ["research", "finance"],
        simulated: true,
        createdAt: NOW,
      }).simulated,
    ).toBe(true);
    expect(
      AgentRecordSchema.safeParse({
        id: "a1",
        organizationId: "org",
        name: "orchestrator",
        department: "research",
        role: "orchestrator",
        key: ADDR,
        createdAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      MissionRecordSchema.safeParse({
        id: "m1",
        organizationId: "org",
        goal: "EV data",
        budgetAtomic: "50000000",
        rootNodeId: 1,
        status: "active",
        createdAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      ResourceRequestRecordSchema.safeParse({
        id: "rr1",
        missionId: "m1",
        agentId: "a1",
        status: "open",
        createdAt: NOW,
        topic: "EV registrations",
        regions: ["California"],
        dateRange: { start: "2024-01-01", end: "2026-12-31" },
        granularity: "monthly",
        requiredFields: ["brand", "units"],
        format: ["csv"],
        license: "company-use",
        freshness: { maxAgeDays: 90 },
        maxPriceAtomic: "15000000",
      }).success,
    ).toBe(true);
    expect(
      ResourceRecordSchema.safeParse({
        id: "r1",
        title: "EV registrations (SIMULATED)",
        createdAt: NOW,
        sellerId: "seller-honest",
        productId: "ev-us-monthly",
        coverage: {
          regions: ["United States"],
          dateRange: { start: "2024-01-01", end: "2026-12-31" },
          granularity: "monthly",
          fields: ["brand", "units", "state"],
          format: "csv",
        },
        license: "company-use",
        priceAtomic: "12000000",
        manifestHash: B32,
        seats: 10,
        simulated: true,
      }).success,
    ).toBe(true);
    expect(
      PurchaseGroupSchema.safeParse({
        id: "pg1",
        missionId: "m1",
        resourceId: "r1",
        payingNodeId: 1,
        requestIds: ["rr1", "rr2"],
        mergeReason: "covers both",
        createdAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      ChainTransactionSchema.safeParse({
        id: "ct1",
        txHash: B32,
        logIndex: 0,
        blockNumber: "123456",
        contractAddress: ADDR,
        eventName: "Paid",
        args: { id: "1", value: "12000000" },
        observedAt: NOW,
        confirmed: true,
      }).success,
    ).toBe(true);
    expect(
      EscrowOrderSchema.safeParse({
        id: "e1",
        purchaseId: "p1",
        orderIdBytes32: B32,
        escrowAddress: ADDR,
        sellerAddress: ADDR,
        amountAtomic: "12000000",
        bondAtomic: "2400000",
        termsHash: B32,
        manifestHash: B32,
        rootPlain: B32,
        rootCipher: B32,
        keyCommitment: B32,
        revealDeadline: "1800000000",
        challengeWindow: "600",
        sourceKey: ADDR,
        minTimestamp: "0",
        status: "Created",
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      ReservationRecordSchema.safeParse({
        id: "res1",
        digest: B32,
        nodeId: 2,
        valueAtomic: "5000000",
        validBefore: "1800000000",
        nonce: B32,
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      SampleRecordSchema.safeParse({
        id: "s1",
        purchaseId: "p1",
        indices: [3, 17, 42],
        verdict: "buy",
        reason: "fields present",
        confidence: 0.9,
        createdAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      SellerHistorySchema.safeParse({
        sellerAddress: ADDR,
        orders: 3,
        onTimeReveals: 3,
        lateReveals: 0,
        provenCheats: 0,
        flagged: false,
        updatedAt: NOW,
      }).success,
    ).toBe(true);
  });

  it("rejects float amounts on purchase rows and keeps the allocation-sum refinement", () => {
    const base = {
      id: "p1",
      orderIdBytes32: B32,
      missionId: "m1",
      resourceId: "r1",
      buyerTreasury: ADDR,
      sellerAddress: ADDR,
      escrowAddress: ADDR,
      chainId: 84532,
      tokenAddress: ADDR,
      amountAtomic: "12000000",
      payingNodeId: 1,
      participatingAgentIds: ["a1"],
      allocations: [{ agentId: "a1", department: "research", amountAtomic: "12000000" }],
      resourceManifestHash: B32,
      termsHash: B32,
      paymentPath: "overflow-facilitator",
      txHashes: [],
      createdAt: NOW,
      authorizationExpiresAt: NOW,
      status: "PROPOSED",
      idempotencyKey: "m1:r1:1",
      updatedAt: NOW,
    };
    expect(PurchaseRecordSchema.safeParse(base).success).toBe(true);
    expect(PurchaseRecordSchema.safeParse({ ...base, amountAtomic: "12.5" }).success).toBe(false);
    expect(PurchaseRecordSchema.safeParse({ ...base, amountAtomic: 12000000 }).success).toBe(false);
    expect(
      PurchaseRecordSchema.safeParse({
        ...base,
        allocations: [{ agentId: "a1", department: "research", amountAtomic: "1" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a financial entry whose debit and credit accounts match", () => {
    const entry = {
      id: "fe1",
      purchaseId: "p1",
      debitAccount: "escrow-deposit",
      creditAccount: "usdc-treasury",
      amountAtomic: "8000000",
      memo: "Escrow funded",
      eventKey: "0xabc:1",
      sourceEventId: "0xabc:1",
      postedAt: NOW,
    };
    expect(FinancialEntrySchema.safeParse(entry).success).toBe(true);
    const { eventKey: _k, ...withoutKey } = entry;
    expect(FinancialEntrySchema.safeParse(withoutKey).success).toBe(false);
    expect(
      FinancialEntrySchema.safeParse({ ...entry, creditAccount: "escrow-deposit" }).success,
    ).toBe(false);
    expect(FinancialEntrySchema.safeParse({ ...entry, amountAtomic: "8.0" }).success).toBe(false);
  });

  it("escrow transitions have exactly two terminal states", () => {
    const terminal = Object.entries(ESCROW_TRANSITIONS).filter(([, to]) => to.length === 0);
    expect(terminal.map(([s]) => s).sort()).toEqual(["Refunded", "Settled"]);
    expect(ESCROW_TRANSITIONS.Created).toEqual(["Funded"]);
  });
});
