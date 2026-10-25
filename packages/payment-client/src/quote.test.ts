import { describe, expect, it } from "vitest";
import { USDC } from "@overflow/schemas";
import { QuoteMismatchError, checkQuote, isCheckedQuote, selectRequirements } from "./index";
import { ATTACKER, ESCROW, SELLER, makeOrder, makeRequirements } from "./test-fixtures";

function expectMismatch(fn: () => unknown, field: string) {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuoteMismatchError);
  expect((caught as QuoteMismatchError).field).toBe(field);
  return caught as QuoteMismatchError;
}

describe("checkQuote", () => {
  it("accepts a quote that matches the order (payTo = escrow)", () => {
    const q = checkQuote(makeRequirements(), makeOrder());
    expect(isCheckedQuote(q)).toBe(true);
    expect(q.payTo).toBe(ESCROW);
    expect(q.payeeKind).toBe("escrow");
    expect(q.value).toBe(8400000n);
    expect(q.valueAtomic).toBe("8400000");
    expect(q.token).toBe(USDC.address);
    expect(q.domain).toEqual({ name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC.address });
    expect(q.maxTimeoutSeconds).toBe(60);
  });

  it("accepts lowercase asset/payTo addresses and normalizes them", () => {
    const q = checkQuote(
      makeRequirements({ asset: USDC.address.toLowerCase(), payTo: ESCROW.toLowerCase() }),
      makeOrder(),
    );
    expect(q.payTo).toBe(ESCROW);
  });

  it("rejects scheme != exact", () => {
    const e = expectMismatch(() => checkQuote(makeRequirements({ scheme: "upto" }), makeOrder()), "scheme");
    expect(e.expected).toBe("exact");
    expect(e.actual).toBe("upto");
  });

  it("rejects network != eip155:84532", () => {
    const e = expectMismatch(() => checkQuote(makeRequirements({ network: "eip155:8453" }), makeOrder()), "network");
    expect(e.expected).toBe("eip155:84532");
  });

  it("rejects asset != USDC", () => {
    expectMismatch(() => checkQuote(makeRequirements({ asset: ATTACKER }), makeOrder()), "asset");
    expectMismatch(() => checkQuote(makeRequirements({ asset: "not-an-address" }), makeOrder()), "asset");
  });

  it("rejects an order whose token is not USDC", () => {
    expectMismatch(() => checkQuote(makeRequirements(), makeOrder({ tokenAddress: ATTACKER })), "order.tokenAddress");
  });

  it("rejects payTo that is neither the order's escrow nor an approved direct seller", () => {
    const e = expectMismatch(() => checkQuote(makeRequirements({ payTo: ATTACKER }), makeOrder()), "payTo");
    expect(e.actual).toBe(ATTACKER);
    // The order's own seller is not enough without the owner's direct allowlist.
    expectMismatch(() => checkQuote(makeRequirements({ payTo: SELLER }), makeOrder()), "payTo");
    // Approved, but not this order's seller.
    expectMismatch(
      () => checkQuote(makeRequirements({ payTo: ATTACKER }), makeOrder(), { approvedDirectSellers: [ATTACKER] }),
      "payTo",
    );
    expectMismatch(() => checkQuote(makeRequirements({ payTo: "0x1234" }), makeOrder()), "payTo");
  });

  it("accepts an approved direct seller that is the order's seller", () => {
    const q = checkQuote(makeRequirements({ payTo: SELLER.toLowerCase() }), makeOrder(), {
      approvedDirectSellers: [SELLER],
    });
    expect(q.payeeKind).toBe("direct-seller");
    expect(q.payTo).toBe(SELLER);
  });

  it("rejects amount != order.amountAtomic (exact, not <=)", () => {
    expectMismatch(() => checkQuote(makeRequirements({ amount: "8400001" }), makeOrder()), "amount");
    expectMismatch(() => checkQuote(makeRequirements({ amount: "8399999" }), makeOrder()), "amount");
    expectMismatch(() => checkQuote(makeRequirements({ amount: "8.4" }), makeOrder()), "amount");
    expectMismatch(() => checkQuote(makeRequirements({ amount: "08400000" }), makeOrder()), "amount");
    expectMismatch(() => checkQuote(makeRequirements({ amount: "0x802b80" }), makeOrder()), "amount");
  });

  it("rejects extra.name / extra.version that are not USDC / 2, or missing", () => {
    expectMismatch(() => checkQuote(makeRequirements({ extra: { name: "USD Coin", version: "2" } }), makeOrder()), "extra.name");
    expectMismatch(() => checkQuote(makeRequirements({ extra: { name: "USDC", version: "1" } }), makeOrder()), "extra.version");
    expectMismatch(() => checkQuote(makeRequirements({ extra: undefined }), makeOrder()), "extra.name");
    expectMismatch(() => checkQuote(makeRequirements({ extra: { version: "2" } }), makeOrder()), "extra.name");
    expectMismatch(() => checkQuote(makeRequirements({ extra: { name: "USDC" } }), makeOrder()), "extra.version");
  });

  it("rejects a non-eip3009 asset transfer method and accepts an explicit eip3009", () => {
    expectMismatch(
      () => checkQuote(makeRequirements({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } }), makeOrder()),
      "extra.assetTransferMethod",
    );
    expect(() =>
      checkQuote(makeRequirements({ extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } }), makeOrder()),
    ).not.toThrow();
  });

  it("rejects malformed requirements and orders with zod errors", () => {
    expect(() => checkQuote({ ...makeRequirements(), maxTimeoutSeconds: 0 }, makeOrder())).toThrow();
    expect(() => checkQuote(makeRequirements(), { ...makeOrder(), chainId: 8453 })).toThrow();
  });
});

describe("selectRequirements", () => {
  const base = { x402Version: 2 as const, resource: { url: "https://seller/x" } };
  it("picks exact on eip155:84532 and ignores the rest", () => {
    const other = makeRequirements({ network: "eip155:8453" });
    const ours = makeRequirements();
    expect(selectRequirements({ ...base, accepts: [other, ours] })).toBe(ours);
    expect(selectRequirements({ ...base, accepts: [makeRequirements({ scheme: "upto" }), other] })).toBeNull();
  });
});
