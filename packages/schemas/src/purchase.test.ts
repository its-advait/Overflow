import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  InvalidTransitionError,
  PURCHASE_STATUSES,
  PurchaseOrderSchema,
  PurchaseStatusSchema,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
  isTerminalStatus,
  type PurchaseOrder,
} from "./index";

const ZERO32 = `0x${"00".repeat(32)}` as const;
const ADDR_A = "0x1111111111111111111111111111111111111111" as const;
const ADDR_B = "0x2222222222222222222222222222222222222222" as const;
const ADDR_C = "0x3333333333333333333333333333333333333333" as const;

describe("PurchaseStatus", () => {
  it("has exactly the eleven spec statuses", () => {
    expect(PURCHASE_STATUSES).toEqual([
      "PROPOSED",
      "RESERVED",
      "PAYMENT_PENDING",
      "ESCROW_FUNDED",
      "DELIVERY_PENDING",
      "SETTLED",
      "REFUNDED",
      "REJECTED",
      "PAYMENT_UNKNOWN",
      "FAILED_BEFORE_FUNDING",
      "RELEASED",
    ]);
    expect(PurchaseStatusSchema.safeParse("settled").success).toBe(false);
  });

  it("every status has a transitions row", () => {
    for (const s of PURCHASE_STATUSES) expect(ALLOWED_TRANSITIONS[s]).toBeDefined();
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...PURCHASE_STATUSES].sort());
  });

  it("terminal statuses are exactly the five with no successors", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ["SETTLED", "REFUNDED", "REJECTED", "FAILED_BEFORE_FUNDING", "RELEASED"].sort(),
    );
    for (const s of PURCHASE_STATUSES) {
      expect(isTerminalStatus(s)).toBe(TERMINAL_STATUSES.includes(s));
    }
  });
});

describe("assertTransition / canTransition over the full matrix", () => {
  const allowedCount = PURCHASE_STATUSES.reduce((n, s) => n + ALLOWED_TRANSITIONS[s].length, 0);

  it("covers every allowed and forbidden pair", () => {
    let allowed = 0;
    let forbidden = 0;
    for (const from of PURCHASE_STATUSES) {
      for (const to of PURCHASE_STATUSES) {
        const expected = ALLOWED_TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(expected);
        if (expected) {
          allowed++;
          expect(assertTransition(from, to)).toBe(to);
        } else {
          forbidden++;
          expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
        }
      }
    }
    expect(allowed).toBe(allowedCount);
    expect(allowed + forbidden).toBe(PURCHASE_STATUSES.length ** 2);
    expect(allowed).toBe(17);
  });

  it("never allows a self-transition", () => {
    for (const s of PURCHASE_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it("nothing leaves a terminal state", () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of PURCHASE_STATUSES) expect(canTransition(from, to)).toBe(false);
    }
  });

  it("walks the happy path", () => {
    const path = [
      "PROPOSED",
      "RESERVED",
      "PAYMENT_PENDING",
      "ESCROW_FUNDED",
      "DELIVERY_PENDING",
      "SETTLED",
    ] as const;
    for (let i = 0; i + 1 < path.length; i++) {
      expect(assertTransition(path[i]!, path[i + 1]!)).toBe(path[i + 1]);
    }
  });

  it("PAYMENT_UNKNOWN resolves only by reconciliation, never a fresh payment", () => {
    expect(canTransition("PAYMENT_PENDING", "PAYMENT_UNKNOWN")).toBe(true);
    expect(canTransition("PAYMENT_UNKNOWN", "PAYMENT_PENDING")).toBe(false);
    expect(canTransition("PAYMENT_UNKNOWN", "RESERVED")).toBe(false);
    expect(canTransition("PAYMENT_UNKNOWN", "PROPOSED")).toBe(false);
    expect(canTransition("PAYMENT_UNKNOWN", "ESCROW_FUNDED")).toBe(true);
    expect(canTransition("PAYMENT_UNKNOWN", "FAILED_BEFORE_FUNDING")).toBe(true);
  });

  it("keeps authorization, funding and settlement separate", () => {
    expect(canTransition("RESERVED", "ESCROW_FUNDED")).toBe(false);
    expect(canTransition("PAYMENT_PENDING", "SETTLED")).toBe(false);
    expect(canTransition("ESCROW_FUNDED", "SETTLED")).toBe(false);
    expect(canTransition("PROPOSED", "PAYMENT_PENDING")).toBe(false);
  });

  it("RELEASED is reachable only from RESERVED; REFUNDED only after funding", () => {
    for (const from of PURCHASE_STATUSES) {
      expect(canTransition(from, "RELEASED")).toBe(from === "RESERVED");
      expect(canTransition(from, "REFUNDED")).toBe(
        from === "ESCROW_FUNDED" || from === "DELIVERY_PENDING",
      );
    }
  });

  it("error carries from and to", () => {
    try {
      assertTransition("SETTLED", "PROPOSED");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      const err = e as InvalidTransitionError;
      expect(err.from).toBe("SETTLED");
      expect(err.to).toBe("PROPOSED");
      expect(err.message).toContain("SETTLED -> PROPOSED");
    }
  });

  it("rejects unknown statuses at runtime", () => {
    expect(() => assertTransition("BOGUS" as never, "PROPOSED")).toThrow();
  });
});

describe("PurchaseOrderSchema", () => {
  const order: PurchaseOrder = {
    id: "po_1",
    orderIdBytes32: ZERO32,
    missionId: "m_1",
    resourceId: "r_1",
    buyerTreasury: ADDR_A,
    sellerAddress: ADDR_B,
    escrowAddress: ADDR_C,
    chainId: 84532,
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amountAtomic: "12000000",
    payingNodeId: 1,
    participatingAgentIds: ["research", "finance"],
    allocations: [
      { agentId: "research", department: "Research", amountAtomic: "8400000" },
      { agentId: "finance", department: "Finance", amountAtomic: "3600000" },
    ],
    resourceManifestHash: ZERO32,
    termsHash: ZERO32,
    paymentPath: "overflow-facilitator",
    txHashes: [],
    createdAt: "2026-10-24T16:00:00Z",
    authorizationExpiresAt: "2026-10-24T16:10:00Z",
    status: "PROPOSED",
  };

  it("parses a valid order with allocations summing to the amount", () => {
    expect(PurchaseOrderSchema.parse(order)).toEqual(order);
  });

  it("accepts an order without allocations", () => {
    expect(PurchaseOrderSchema.safeParse({ ...order, allocations: [] }).success).toBe(true);
  });

  it("rejects allocations that do not sum to amountAtomic", () => {
    const bad = {
      ...order,
      allocations: [{ agentId: "research", department: "Research", amountAtomic: "8400000" }],
    };
    const res = PurchaseOrderSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0]?.path).toEqual(["allocations"]);
  });

  it("rejects a wrong chain, float amounts, bad hex and extra-decimal amounts", () => {
    expect(PurchaseOrderSchema.safeParse({ ...order, chainId: 1 }).success).toBe(false);
    expect(PurchaseOrderSchema.safeParse({ ...order, amountAtomic: "12.0" }).success).toBe(false);
    expect(PurchaseOrderSchema.safeParse({ ...order, amountAtomic: 12 }).success).toBe(false);
    expect(PurchaseOrderSchema.safeParse({ ...order, termsHash: "0x1234" }).success).toBe(false);
    expect(PurchaseOrderSchema.safeParse({ ...order, payingNodeId: 0 }).success).toBe(false);
    expect(PurchaseOrderSchema.safeParse({ ...order, paymentPath: "direct" }).success).toBe(false);
    expect(PurchaseOrderSchema.safeParse({ ...order, status: "DONE" }).success).toBe(false);
  });

  it("accepts an optional authorizationDigest", () => {
    expect(
      PurchaseOrderSchema.safeParse({ ...order, authorizationDigest: ZERO32 }).success,
    ).toBe(true);
  });
});
