import { describe, expect, it } from "vitest";
import {
  ActivityEventSchema,
  AgentNodeSchema,
  ControllerRequestSchema,
  DateRangeSchema,
  ExceptionRecordSchema,
  JournalEntrySchema,
  MissionSchema,
  ResourceListingSchema,
  ResourceRequestSchema,
  type ResourceRequest,
} from "./index";

const ADDR = "0x1111111111111111111111111111111111111111";
const B32 = `0x${"11".repeat(32)}`;
const NOW = "2026-10-24T16:00:00Z";

describe("ResourceRequest / ResourceListing", () => {
  const request: ResourceRequest = {
    topic: "EV registrations",
    regions: ["California"],
    dateRange: { start: "2024-01-01", end: "2026-12-31" },
    granularity: "monthly",
    requiredFields: ["brand", "units"],
    format: ["csv"],
    license: "company-use",
    freshness: { maxAgeDays: 90 },
    maxPriceAtomic: "15000000",
  };

  it("parses a valid request", () => {
    expect(ResourceRequestSchema.parse(request)).toEqual(request);
  });

  it("allows an unclear license (Fusion treats it as no merge)", () => {
    expect(ResourceRequestSchema.safeParse({ ...request, license: "unclear" }).success).toBe(true);
  });

  it("rejects empty regions, bad granularity, float prices and reversed date ranges", () => {
    expect(ResourceRequestSchema.safeParse({ ...request, regions: [] }).success).toBe(false);
    expect(ResourceRequestSchema.safeParse({ ...request, granularity: "hourly" }).success).toBe(false);
    expect(ResourceRequestSchema.safeParse({ ...request, maxPriceAtomic: "15.0" }).success).toBe(false);
    expect(
      ResourceRequestSchema.safeParse({
        ...request,
        dateRange: { start: "2026-12-31", end: "2024-01-01" },
      }).success,
    ).toBe(false);
    expect(DateRangeSchema.safeParse({ start: "2024-01-01", end: "2024-01-01" }).success).toBe(true);
    expect(DateRangeSchema.safeParse({ start: "2024-1-1", end: "2024-01-01" }).success).toBe(false);
  });

  it("parses a listing and defaults simulated to false", () => {
    const listing = ResourceListingSchema.parse({
      sellerId: "seller-honest",
      productId: "ev-us-monthly",
      coverage: {
        regions: ["United States"],
        dateRange: { start: "2024-01-01", end: "2026-09-30" },
        granularity: "monthly",
        fields: ["brand", "units", "state"],
        format: "csv",
      },
      license: "company-use",
      priceAtomic: "12000000",
      manifestHash: B32,
      seats: 5,
    });
    expect(listing.simulated).toBe(false);
    expect(ResourceListingSchema.safeParse({ ...listing, seats: 0 }).success).toBe(false);
  });
});

describe("Mission / AgentNode", () => {
  it("parses a mission", () => {
    expect(
      MissionSchema.safeParse({
        id: "m1",
        goal: "Research the EV market",
        budgetAtomic: "50000000",
        rootNodeId: 1,
        status: "active",
        createdAt: NOW,
      }).success,
    ).toBe(true);
  });

  it("mirrors the onchain Node struct and caps depth at 2", () => {
    const node = {
      id: 2,
      key: ADDR,
      parent: 1,
      depth: 1,
      cap: "20000000",
      spent: "0",
      maxPerCall: "5000000",
      expiry: "1761350400",
      paused: false,
      restricted: true,
    };
    expect(AgentNodeSchema.safeParse(node).success).toBe(true);
    expect(AgentNodeSchema.safeParse({ ...node, depth: 3 }).success).toBe(false);
    expect(AgentNodeSchema.safeParse({ ...node, id: 0 }).success).toBe(false);
    expect(AgentNodeSchema.safeParse({ ...node, parent: -1 }).success).toBe(false);
    expect(AgentNodeSchema.safeParse({ ...node, cap: 20 }).success).toBe(false);
  });
});

describe("JournalEntry", () => {
  const funded = {
    id: "je1",
    purchaseId: "po1",
    postedAt: NOW,
    memo: "Escrow funded",
    chainEvent: "OrderFunded",
    txHash: B32,
    lines: [
      { account: "escrow-deposit", debitAtomic: "8000000", creditAtomic: "0" },
      { account: "usdc-treasury", debitAtomic: "0", creditAtomic: "8000000" },
    ],
  };

  it("accepts a balanced entry", () => {
    expect(JournalEntrySchema.safeParse(funded).success).toBe(true);
  });

  it("accepts a department split that keeps the total", () => {
    const split = {
      ...funded,
      memo: "Delivery accepted",
      chainEvent: "PaidOut",
      lines: [
        { account: "data-expense", department: "Research", debitAtomic: "8400000", creditAtomic: "0" },
        { account: "data-expense", department: "Finance", debitAtomic: "3600000", creditAtomic: "0" },
        { account: "escrow-deposit", debitAtomic: "0", creditAtomic: "12000000" },
      ],
    };
    expect(JournalEntrySchema.safeParse(split).success).toBe(true);
  });

  it("rejects unbalanced entries, single lines and lines that are both debit and credit", () => {
    expect(
      JournalEntrySchema.safeParse({
        ...funded,
        lines: [funded.lines[0], { ...funded.lines[1], creditAtomic: "7000000" }],
      }).success,
    ).toBe(false);
    expect(JournalEntrySchema.safeParse({ ...funded, lines: [funded.lines[0]] }).success).toBe(false);
    expect(
      JournalEntrySchema.safeParse({
        ...funded,
        lines: [
          { account: "escrow-deposit", debitAtomic: "1", creditAtomic: "1" },
          { account: "usdc-treasury", debitAtomic: "1", creditAtomic: "1" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("ActivityEvent / ExceptionRecord / ControllerRequest", () => {
  it("activity defaults simulated to false and carries a decoded revert", () => {
    const ev = ActivityEventSchema.parse({
      id: "a1",
      at: NOW,
      kind: "policy.blocked",
      message: "Blocked",
      decodedRevert: "OverBudget(3)",
    });
    expect(ev.simulated).toBe(false);
    expect(ActivityEventSchema.safeParse({ ...ev, kind: "nope" }).success).toBe(false);
  });

  it("exception records", () => {
    expect(
      ExceptionRecordSchema.safeParse({
        id: "x1",
        type: "reconciliation-difference",
        reason: "ledger off by 0.50 USDC",
        amountAtomic: "500000",
        status: "open",
        openedAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      ExceptionRecordSchema.safeParse({
        id: "x1",
        type: "typo",
        reason: "r",
        status: "open",
        openedAt: NOW,
      }).success,
    ).toBe(false);
  });

  it("controller requests are a discriminated union on action.kind", () => {
    const base = { id: "c1", requestedBy: "research", reason: "need more budget", status: "pending", createdAt: NOW };
    expect(
      ControllerRequestSchema.safeParse({
        ...base,
        action: { kind: "raise-cap", nodeId: 2, newCapAtomic: "30000000" },
      }).success,
    ).toBe(true);
    expect(
      ControllerRequestSchema.safeParse({
        ...base,
        action: { kind: "set-allow", payee: ADDR, allowed: true },
      }).success,
    ).toBe(true);
    // wrong params for the kind
    expect(
      ControllerRequestSchema.safeParse({
        ...base,
        action: { kind: "raise-cap", payee: ADDR },
      }).success,
    ).toBe(false);
    expect(
      ControllerRequestSchema.safeParse({
        ...base,
        action: { kind: "self-destruct" },
      }).success,
    ).toBe(false);
  });
});
