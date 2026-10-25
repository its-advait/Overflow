import { describe, expect, it } from "vitest";
import * as fx from "../mocks/fixtures";
import { deriveTimeline, parseTransition } from "./timeline";

const input = (id: string) => {
  const purchase = fx.purchaseById(id)!;
  return {
    purchase,
    chainTransactions: fx.chainTransactions.filter((t) => t.purchaseId === id),
    activity: fx.activity.filter((e) => e.purchaseId === id),
    escrow: fx.escrowByPurchase(id) ?? null,
  };
};
const states = (steps: ReturnType<typeof deriveTimeline>) => steps.map((s) => `${s.status}:${s.state}`);

describe("deriveTimeline", () => {
  it("settled merged purchase: six done steps, tx links only from chain events", () => {
    const steps = deriveTimeline(input("pur-merged-national"));
    expect(states(steps)).toEqual([
      "PROPOSED:done",
      "RESERVED:done",
      "PAYMENT_PENDING:done",
      "ESCROW_FUNDED:done",
      "DELIVERY_PENDING:done",
      "SETTLED:done",
    ]);
    const funded = steps.find((s) => s.status === "ESCROW_FUNDED")!;
    expect(funded).toMatchObject({ source: "chain", txHash: fx.chainTransactions.find((t) => t.id === "ctx-merged-funded")!.txHash, blockNumber: "49850120" });
    expect(steps.find((s) => s.status === "SETTLED")!.source).toBe("chain");
    expect(steps.find((s) => s.status === "DELIVERY_PENDING")!.txHash).toBeUndefined();
  });

  it("refunded purchase ends in REFUNDED with the Refunded tx and the escrow's reason; no SETTLED row", () => {
    const steps = deriveTimeline(input("pur-freight-weekly"));
    expect(states(steps).at(-1)).toBe("REFUNDED:done");
    expect(steps.some((s) => s.status === "SETTLED")).toBe(false);
    const refunded = steps.at(-1)!;
    expect(refunded.txHash).toBe(fx.chainTransactions.find((t) => t.id === "ctx-freight-refunded")!.txHash);
    expect(refunded.note).toContain("reveal deadline passed");
  });

  it("rejected retry: REJECTED is current with the decoded revert, later steps skipped, nothing funded", () => {
    const steps = deriveTimeline(input("pur-freight-retry"));
    const rejected = steps.find((s) => s.status === "REJECTED")!;
    expect(rejected).toMatchObject({ state: "current", decodedRevert: "OverBudget(3)", source: "service" });
    expect(steps.find((s) => s.status === "ESCROW_FUNDED")!.state).toBe("skipped");
    expect(steps.every((s) => s.status === "PROPOSED" || s.status === "REJECTED" || s.txHash === undefined)).toBe(true);
  });

  it("payment pending without a submission hash shows no link and keeps funding pending", () => {
    const steps = deriveTimeline(input("pur-california-weekly"));
    expect(states(steps)).toEqual([
      "PROPOSED:done",
      "RESERVED:done",
      "PAYMENT_PENDING:current",
      "ESCROW_FUNDED:pending",
      "DELIVERY_PENDING:pending",
      "SETTLED:pending",
    ]);
    expect(steps.every((s) => s.txHash === undefined)).toBe(true);
  });

  it("a PROPOSED row has one done step and no evidence anywhere else", () => {
    const base = fx.purchaseById("pur-merged-national")!;
    const { authorizationDigest: _d, ...rest } = base;
    void _d;
    const steps = deriveTimeline({ purchase: { ...rest, status: "PROPOSED", txHashes: [] }, chainTransactions: [], activity: [] });
    expect(states(steps)[0]).toBe("PROPOSED:current");
    expect(steps.slice(1).every((s) => s.state === "pending" && s.source === "none")).toBe(true);
  });

  it("parses the PurchaseService transition prefix", () => {
    expect(parseTransition("RESERVED -> PAYMENT_PENDING: submitting payment [adapter:x]")).toEqual({ from: "RESERVED", to: "PAYMENT_PENDING" });
    expect(parseTransition("OrderFunded confirmed")).toBeNull();
  });
});
