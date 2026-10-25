import { describe, expect, it } from "vitest";
import { pay } from "./pay";
import { ATTACKER, defaultChain, FakeFetch, json, NOW, PREMIUM_URL, response402, SEARCH_PAYEE, SEARCH_URL, SELLER_URL, sellerRoutes, SERVICE_URL, spySigner, TREASURY, TX, verifyRoute } from "./test-fixtures";
import type { ChainReader } from "./chain";

function deps(ff: FakeFetch, signer = spySigner(), chain: ChainReader = defaultChain()) {
  return { fetch: ff.fetch, chain, signer, treasury: TREASURY, serviceUrl: SERVICE_URL, now: () => NOW };
}

describe("overflow_pay", () => {
  it("pays /api/search once: quote → chain prechecks → one signature → /verify → one paid request → body + tx hash", async () => {
    const ff = new FakeFetch([...sellerRoutes(), verifyRoute]);
    const signer = spySigner();
    const r = await pay(deps(ff, signer), SEARCH_URL, "20000");
    expect(r).toMatchObject({ paid: true, txHash: TX, explorerUrl: `https://sepolia.basescan.org/tx/${TX}`, amountAtomic: "20000", amountUsdc: "0.02", payTo: SEARCH_PAYEE, nodeId: "1", httpStatus: 200 });
    if (!r.paid) throw new Error("unreachable");
    expect((r.body as { results: unknown[] }).results).toHaveLength(1);
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);
    // Order: unauthenticated GET, /verify, paid GET. The header reaches the seller only after /verify approved.
    expect(ff.calls.map((c) => (c.url === `${SERVICE_URL}/verify` ? "verify" : c.paymentSignature ? "seller+sig" : "seller"))).toEqual(["seller", "verify", "seller+sig"]);
  });

  it("refuses before signing when the price exceeds maxAmount; a float maxAmount is rejected outright", async () => {
    const ff = new FakeFetch([...sellerRoutes(), verifyRoute]);
    const signer = spySigner();
    const r = await pay(deps(ff, signer), SEARCH_URL, "19999");
    expect(r).toMatchObject({ paid: false, kind: "refused", signed: false, sentToSeller: false, refusal: { name: "AboveMaxAmount", args: ["20000", "19999"] }, priceAtomic: "20000", payTo: SEARCH_PAYEE, httpStatus: 402 });
    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(ff.sellerCalls()).toHaveLength(1);
    expect(ff.verifyCalls()).toHaveLength(0);
    await expect(pay(deps(ff, signer), SEARCH_URL, "1.5")).rejects.toThrow();
    await expect(pay(deps(ff, signer), SEARCH_URL, "0.02")).rejects.toThrow();
  });

  it("/premium-intel: the attacker payee is not on the owner allowlist, so nothing is signed and the refusal is PayeeNotAllowed(0)", async () => {
    const ff = new FakeFetch([...sellerRoutes(), verifyRoute]);
    const signer = spySigner();
    const r = await pay(deps(ff, signer), PREMIUM_URL, "50000");
    expect(r).toMatchObject({ paid: false, kind: "refused", signed: false, sentToSeller: false, refusal: { name: "PayeeNotAllowed", args: ["0"], decoded: "PayeeNotAllowed(0)", reason: "Recipient is not approved for anyone" }, payTo: ATTACKER, priceAtomic: "50000" });
    if (r.paid || r.kind !== "refused") throw new Error("unreachable");
    expect(r.refusal.source).toContain("client-precheck");
    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(ff.sellerCalls()).toHaveLength(1);
    expect(ff.sellerCalls()[0]!.paymentSignature).toBeNull();
  });

  it("when the chain read passes but /verify refuses, exactly one signature exists and the seller never sees it", async () => {
    // The fake chain claims the attacker is allowlisted (a stale read); the treasury's simulation disagrees.
    const ff = new FakeFetch([...sellerRoutes(), verifyRoute]);
    const signer = spySigner();
    const r = await pay(deps(ff, signer, defaultChain({ allowlist: [SEARCH_PAYEE, ATTACKER] })), PREMIUM_URL, "50000");
    expect(r).toMatchObject({ paid: false, kind: "refused", signed: true, sentToSeller: false, refusal: { name: "PayeeNotAllowed", args: ["0"] } });
    if (r.paid || r.kind !== "refused") throw new Error("unreachable");
    expect(r.refusal.source).toContain("/verify");
    expect(r.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);
    expect(ff.sellerCalls()).toHaveLength(1);
    expect(ff.sellerCalls()[0]!.paymentSignature).toBeNull();
    expect(ff.verifyCalls()).toHaveLength(1);
  });

  it("the seller's own settle revert (402 payment_blocked) is returned as the decoded refusal with its tx hash", async () => {
    const blocked = sellerRoutes({
      paidSearch: ({ url }) => response402(url, SEARCH_PAYEE, "20000", { extra: { error: "payment_blocked", decoded: { name: "OverBudget", args: ["1"], decoded: "OverBudget(1)", reason: "Agent 1 or an ancestor would pass its cap" }, txHash: TX } }),
    });
    const ff = new FakeFetch([...blocked, verifyRoute]);
    const r = await pay(deps(ff), SEARCH_URL, "20000");
    expect(r).toMatchObject({ paid: false, kind: "refused", signed: true, sentToSeller: true, refusal: { name: "OverBudget", args: ["1"], decoded: "OverBudget(1)" }, txHash: TX, httpStatus: 402 });
  });

  it("a paid request that fails in flight is an unknown outcome with the digest; nothing is retried", async () => {
    const ff = new FakeFetch([
      ({ url, paymentSignature }) => {
        if (!url.startsWith(`${SELLER_URL}/api/search`)) return null;
        if (!paymentSignature) return response402(url, SEARCH_PAYEE, "20000");
        throw new Error("socket hang up");
      },
      verifyRoute,
    ]);
    const signer = spySigner();
    const r = await pay(deps(ff, signer), SEARCH_URL, "20000");
    expect(r).toMatchObject({ paid: false, kind: "unknown", reason: expect.stringContaining("socket hang up") });
    if (r.paid || r.kind !== "unknown") throw new Error("unreachable");
    expect(r.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.instruction).toContain("never sign a new authorization");
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);
    expect(ff.calls).toHaveLength(3);
  });

  it("a 200 without a PAYMENT-RESPONSE is never reported as paid; a free resource is not paywalled; an unregistered key is UnknownAgent", async () => {
    const noReceipt = new FakeFetch([...sellerRoutes({ paidSearch: () => json(200, { results: [] }) }), verifyRoute]);
    expect(await pay(deps(noReceipt), SEARCH_URL, "20000")).toMatchObject({ paid: false, kind: "unknown", httpStatus: 200 });
    const free = new FakeFetch([({ url }) => (url === `${SELLER_URL}/free` ? json(200, { ok: true }) : null)]);
    expect(await pay(deps(free), `${SELLER_URL}/free`, "1")).toMatchObject({ paid: false, kind: "not-paywalled", httpStatus: 200 });
    const ff = new FakeFetch([...sellerRoutes(), verifyRoute]);
    const signer = spySigner();
    const r = await pay(deps(ff, signer, defaultChain({ keys: {} })), SEARCH_URL, "20000");
    expect(r).toMatchObject({ paid: false, kind: "refused", signed: false, refusal: { name: "UnknownAgent" } });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });
});
