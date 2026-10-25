import { describe, expect, it } from "vitest";
import { quote, QUOTE_PROBE_TTL_SECONDS } from "./quote";
import { defaultChain, FakeFetch, json, NOW, PREMIUM_URL, response402, SEARCH_PAYEE, SEARCH_URL, SELLER_URL, sellerRoutes, SERVICE_URL, spySigner, TREASURY, verifyRoute } from "./test-fixtures";

function deps(ff: FakeFetch, signer = spySigner()) {
  return { fetch: ff.fetch, chain: defaultChain(), signer, treasury: TREASURY, serviceUrl: SERVICE_URL, now: () => NOW };
}

describe("overflow_quote", () => {
  it("reports price and payee, reads the chain, and gets the treasury's verdict from /verify without touching the seller twice", async () => {
    const ff = new FakeFetch([...sellerRoutes(), verifyRoute]);
    const signer = spySigner();
    const q = await quote(deps(ff, signer), SEARCH_URL);
    expect(q).toMatchObject({
      paywalled: true,
      payable: true,
      priceAtomic: "20000",
      priceUsdc: "0.02",
      payTo: SEARCH_PAYEE,
      simulatedSeller: true,
      allowlisted: true,
      withinPerCall: true,
      withinRemaining: true,
      policy: { allowed: true, refusal: null, nodeId: "1", simulated: true, broadcast: false },
    });
    if (!q.paywalled) throw new Error("unreachable");
    expect(q.policy.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number(q.policy.validBefore) - NOW).toBeLessThanOrEqual(QUOTE_PROBE_TTL_SECONDS);
    // One probe signature, sent to the facilitator only; the seller saw one unauthenticated GET.
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);
    expect(ff.sellerCalls()).toHaveLength(1);
    expect(ff.sellerCalls()[0]!.paymentSignature).toBeNull();
    expect(ff.verifyCalls()).toHaveLength(1);
    const body = ff.verifyBodies[0] as { paymentPayload: { payload: { authorization: { from: string; to: string; value: string } } }; paymentRequirements: { payTo: string; amount: string } };
    expect(body.paymentPayload.payload.authorization.from.toLowerCase()).toBe(TREASURY.toLowerCase());
    expect(body.paymentPayload.payload.authorization.to.toLowerCase()).toBe(SEARCH_PAYEE.toLowerCase());
    expect(body.paymentPayload.payload.authorization.value).toBe("20000");
    expect(body.paymentRequirements).toMatchObject({ payTo: SEARCH_PAYEE, amount: "20000" });
  });

  it("the attacker's /premium-intel: not allowlisted, and the treasury's own PayeeNotAllowed(0) comes back from /verify", async () => {
    const ff = new FakeFetch([...sellerRoutes(), verifyRoute]);
    const q = await quote(deps(ff), PREMIUM_URL);
    if (!q.paywalled) throw new Error("unreachable");
    expect(q.payable).toBe(true);
    expect(q.priceAtomic).toBe("50000");
    expect(q.allowlisted).toBe(false);
    expect(q.policy.allowed).toBe(false);
    expect(q.policy.refusal).toMatchObject({ name: "PayeeNotAllowed", args: ["0"], decoded: "PayeeNotAllowed(0)", reason: "Recipient is not approved for anyone" });
    expect(q.policy.refusal?.source).toContain("/verify");
    expect(ff.sellerCalls().every((c) => c.paymentSignature === null)).toBe(true);
  });

  it("falls back to the JSON body when the 402 has no PAYMENT-REQUIRED header", async () => {
    const ff = new FakeFetch([({ url }) => (url === SEARCH_URL ? response402(url, SEARCH_PAYEE, "20000", { header: false }) : null), verifyRoute]);
    const q = await quote(deps(ff), SEARCH_URL);
    expect(q).toMatchObject({ paywalled: true, priceAtomic: "20000", policy: { allowed: true } });
  });

  it("a non-402 is reported, not paid; an unpayable 402 is reported with the reason and nothing is signed", async () => {
    const free = new FakeFetch([({ url }) => (url === `${SELLER_URL}/free` ? json(200, { ok: true }) : null)]);
    expect(await quote(deps(free), `${SELLER_URL}/free`)).toMatchObject({ paywalled: false, httpStatus: 200 });
    const signer = spySigner();
    const other = new FakeFetch([
      ({ url }) =>
        url === SEARCH_URL
          ? json(402, { x402Version: 2, resource: { url }, accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: SEARCH_PAYEE, amount: "20000", maxTimeoutSeconds: 60 }] })
          : null,
    ]);
    const q = await quote(deps(other, signer), SEARCH_URL);
    expect(q).toMatchObject({ paywalled: true, payable: false, policy: { allowed: false, refusal: { name: "UnsupportedQuote" } } });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });
});
