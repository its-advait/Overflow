import { describe, expect, it } from "vitest";
import type { MissionRecord, PurchaseRecord } from "@overflow/schemas";
import * as fx from "../mocks/fixtures";
import { createMockApi } from "../api/mock";
import { activeMissions, blockedReason, eventTone, isBlocked, latestEvents, missionProgress, pickMission, PURCHASE_STAGE, spentForMission } from "./index";

const withStatus = (status: PurchaseRecord["status"]): PurchaseRecord => ({ ...fx.purchases[0]!, status });

describe("overview progress strip", () => {
  it("counts requests as Discovered and purchases per the furthest stage their stored status proves", () => {
    const p = missionProgress({ requests: fx.requests, purchases: fx.purchases });
    // fixtures: 4 requests (none withdrawn); 6 purchases: SETTLED, ESCROW_FUNDED, DELIVERY_PENDING, PAYMENT_PENDING, REFUNDED, REJECTED
    expect(p.stages.map((s) => [s.stage, s.count])).toEqual([
      ["Discovered", 4],
      ["Grouped", 6],
      ["Authorized", 5],
      ["Escrow", 4],
      ["Settled", 1],
    ]);
    expect(p.current).toBe("Settled");
  });
  it("a draft mission with nothing filed reaches no stage", () => {
    const p = missionProgress({ requests: [], purchases: [] });
    expect(p.stages.every((s) => !s.reached && s.count === 0)).toBe(true);
    expect(p.current).toBeNull();
  });
  it("keeps the three money events apart: a rejection never counts as authorized, a refund reached escrow but not settlement", () => {
    expect(PURCHASE_STAGE.REJECTED).toBe("Grouped");
    expect(PURCHASE_STAGE.REFUNDED).toBe("Escrow");
    expect(PURCHASE_STAGE.RESERVED).toBe("Authorized");
    const p = missionProgress({ requests: fx.requests, purchases: [withStatus("REJECTED"), withStatus("REFUNDED")] });
    expect(p.stages.find((s) => s.stage === "Authorized")!.count).toBe(1);
    expect(p.stages.find((s) => s.stage === "Settled")!.count).toBe(0);
    expect(p.current).toBe("Escrow");
  });
  it("withdrawn requests are not discovered", () => {
    const p = missionProgress({ requests: fx.requests.map((r) => ({ ...r, status: "withdrawn" as const })), purchases: [] });
    expect(p.stages[0]!.count).toBe(0);
  });
});

describe("overview missions", () => {
  const m = (id: string, status: MissionRecord["status"], createdAt: string): MissionRecord => ({ ...fx.mission, id, status, createdAt });
  it("lists missions in flight newest first and leaves out complete and cancelled ones", () => {
    const rows = activeMissions([m("a", "complete", "2026-01-03T00:00:00Z"), m("b", "draft", "2026-01-01T00:00:00Z"), m("c", "active", "2026-01-02T00:00:00Z"), m("d", "cancelled", "2026-01-04T00:00:00Z")]);
    expect(rows.map((r) => r.id)).toEqual(["c", "b"]);
  });
  it("picks the newest active mission for the Spent card, else the newest of any status", () => {
    expect(pickMission([m("a", "active", "2026-01-01T00:00:00Z"), m("b", "active", "2026-01-02T00:00:00Z"), m("c", "draft", "2026-01-03T00:00:00Z")])!.id).toBe("b");
    expect(pickMission([m("a", "complete", "2026-01-01T00:00:00Z"), m("c", "draft", "2026-01-03T00:00:00Z")])!.id).toBe("c");
    expect(pickMission([])).toBeUndefined();
  });
  it("spent is the booked data-expense of the mission's purchases, from the ledger's allocation breakdown", async () => {
    const ledger = await createMockApi().getLedger();
    const spent = spentForMission(fx.purchases.map((p) => p.id), ledger.allocations);
    const booked = fx.ledgerEntries.reduce(
      (n, e) => n + (e.debitAccount === "data-expense" && e.purchaseId ? BigInt(e.amountAtomic) : 0n) - (e.creditAccount === "data-expense" && e.purchaseId ? BigInt(e.amountAtomic) : 0n),
      0n,
    );
    expect(spent).toBe(booked);
    expect(spent).toBeGreaterThan(0n);
    expect(spentForMission(["pur-none"], ledger.allocations)).toBe(0n);
  });
});

describe("overview events", () => {
  it("the latest five are newest first and the blocked one carries its decoded revert", () => {
    const latest = latestEvents(fx.activity, 5);
    expect(latest).toHaveLength(5);
    for (let i = 1; i < latest.length; i++) expect(latest[i - 1]!.at >= latest[i]!.at).toBe(true);
    const blocked = fx.activity.find((e) => e.kind === "policy.blocked")!;
    expect(isBlocked(blocked)).toBe(true);
    expect(blockedReason(blocked)).toBe("OverBudget(3)");
    expect(eventTone(blocked.kind)).toBe("danger");
    expect(isBlocked(fx.activity.find((e) => e.kind === "escrow.settled")!)).toBe(false);
    expect(blockedReason(fx.activity[0]!)).toBeUndefined();
  });
  it("the mock treasury reading matches the fixture reconciliation and the funded escrows", async () => {
    const t = await createMockApi().getTreasury();
    expect(t.chain?.balanceAtomic).toBe(fx.reconciliationRun.treasuryChainAtomic);
    expect(t.chain?.reservedTotalAtomic).toBe("0");
    const funded = fx.escrows.filter((e) => e.status === "Funded" || e.status === "Revealed");
    expect(t.escrow.fundedOrders).toBe(funded.length);
    expect(t.escrow.committedAtomic).toBe(funded.reduce((n, e) => n + BigInt(e.amountAtomic), 0n).toString());
    expect(t.escrow.openOrders).toBe(3);
  });
});
