import {
  buildPaymentHeader,
  buildPaymentPayload,
  checkQuote,
  parsePaymentRequired,
  parsePaymentResponse,
  QuoteMismatchError,
  selectRequirements,
  signTransfer,
  wrapFetch,
  X402_HEADERS,
  type PaymentRequirements,
} from "@overflow/payment-client";
import { USDC, type Address, type Hex } from "@overflow/schemas";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { Facilitator, SettleInput, SettleOutcome } from "../facilitator/settle.js";
import { createSellerApp, MISMATCHED_QUOTE_PATH } from "./app.js";
import type { SellerConfig } from "./config.js";
import { directApiOrder } from "./direct-order.js";
import { HIDDEN_INSTRUCTION, LISTING_PATH, PREMIUM_INTEL_PATH } from "./listing.js";
import { DECOY_PAYEE, FORCE_BROADCAST_HEADER, PREMIUM_INTEL_PRICE_ATOMIC, SCRAPE_PRICE_ATOMIC, SEARCH_PRICE_ATOMIC } from "./prices.js";

// SIMULATED fixtures.
const TREASURY = "0x1111111111111111111111111111111111111111" as Address;
const SEARCH_PAYEE = "0x2222222222222222222222222222222222222222" as Address;
const SCRAPE_PAYEE = "0x3333333333333333333333333333333333333333" as Address;
const ATTACKER = "0x4444444444444444444444444444444444444444" as Address; // SIMULATED attacker payee
const NODE = privateKeyToAccount(keccak256(toBytes("overflow.test.node-key")));
const TX = `0x${"77".repeat(32)}` as Hex;
const SELLER_URL = "http://localhost:4100";

const config = (over: Partial<SellerConfig> = {}): SellerConfig => ({
  sellerUrl: SELLER_URL,
  port: 4100,
  payees: { search: SEARCH_PAYEE, scrape: SCRAPE_PAYEE },
  payeeSource: "env",
  attacker: ATTACKER,
  contextDevKey: null,
  allowForceBroadcast: false,
  ...over,
});

/** SIMULATED facilitator: records calls, never touches a chain. */
function fakeFacilitator(outcome: (input: SettleInput) => SettleOutcome) {
  const calls: SettleInput[] = [];
  const facilitator: Facilitator = {
    async settle(input) {
      calls.push(input);
      return outcome(input);
    },
  };
  return { facilitator, calls };
}
const paid = (): SettleOutcome => ({ outcome: "paid", txHash: TX, blockNumber: "42", nodeId: "3", payer: NODE.address, digest: `0x${"d1".repeat(32)}` as Hex });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

async function payHeader(requirements: PaymentRequirements, over: { to?: Address; value?: string } = {}) {
  const signed = await signTransfer({ nodeAccount: NODE, treasury: TREASURY, to: over.to ?? (requirements.payTo as Address), value: over.value ?? requirements.amount, ttlSeconds: 120 });
  return buildPaymentHeader(buildPaymentPayload({ accepted: { ...requirements, payTo: signed.authorization.to, amount: signed.authorization.value.toString() }, signed }));
}

describe("SIMULATED sellers: 402 quotes", () => {
  const app = createSellerApp({ config: config(), facilitator: null, facilitatorUnavailableReason: "test: none" });

  it.each([
    ["/api/search?q=ev", SEARCH_PRICE_ATOMIC, SEARCH_PAYEE],
    [`/api/scrape?url=${encodeURIComponent("https://example.com")}`, SCRAPE_PRICE_ATOMIC, SCRAPE_PAYEE],
    [PREMIUM_INTEL_PATH, PREMIUM_INTEL_PRICE_ATOMIC, ATTACKER],
  ])("%s answers a standard x402 v2 402", async (path, amount, payTo) => {
    const res = await app.request(path);
    expect(res.status).toBe(402);
    const required = parsePaymentRequired(res);
    const r = selectRequirements(required);
    expect(r).toMatchObject({ scheme: "exact", network: "eip155:84532", asset: USDC.address, amount, payTo, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" } });
    expect(required.resource.url).toBe(`${SELLER_URL}${new URL(path, SELLER_URL).pathname}`);
    const body = await json(res);
    expect(body.simulated).toBe(true);
    expect(body.accepts[0].payTo).toBe(payTo);
  });

  it("the attacker payee is distinct from every legitimate payee and never a default", () => {
    expect(ATTACKER).not.toBe(SEARCH_PAYEE);
    expect(ATTACKER).not.toBe(SCRAPE_PAYEE);
    expect(DECOY_PAYEE).not.toBe(ATTACKER);
  });

  it("/premium-intel answers 503 when no attacker address is configured", async () => {
    const noAttacker = createSellerApp({ config: config({ attacker: null }), facilitator: null });
    const res = await noAttacker.request(PREMIUM_INTEL_PATH);
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe("fixture_not_configured");
  });

  it("serves the free listing fixture with the hidden instruction and the fixture label", async () => {
    const res = await app.request(LISTING_PATH);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="hidden-note"');
    expect(html).toContain(HIDDEN_INSTRUCTION(SELLER_URL));
    expect(html).toContain(`${SELLER_URL}${PREMIUM_INTEL_PATH}`);
    expect(html).toContain("TEST FIXTURE (SIMULATED)");
  });

  it("the mismatched-quote fixture disagrees with the listing on the requested field", async () => {
    const amount = await app.request(`${MISMATCHED_QUOTE_PATH}?field=amount`);
    expect(amount.status).toBe(402);
    const a = selectRequirements(parsePaymentRequired(amount))!;
    expect(a.payTo).toBe(SEARCH_PAYEE);
    expect(BigInt(a.amount)).toBe(BigInt(SEARCH_PRICE_ATOMIC) * 3n);
    const bodyA = await json(amount);
    expect(bodyA).toMatchObject({ fixture: "mismatched-quote", mismatch: "amount", listed: { amountAtomic: SEARCH_PRICE_ATOMIC, payTo: SEARCH_PAYEE }, simulated: true });

    const payTo = await app.request(`${MISMATCHED_QUOTE_PATH}?field=payTo`);
    const p = selectRequirements(parsePaymentRequired(payTo))!;
    expect(p.payTo).toBe(DECOY_PAYEE);
    expect(p.amount).toBe(SEARCH_PRICE_ATOMIC);

    const bad = await app.request(`${MISMATCHED_QUOTE_PATH}?field=asset`);
    expect(bad.status).toBe(400);
  });
});

describe("SIMULATED sellers: paywall outcomes", () => {
  it("rejects a malformed PAYMENT-SIGNATURE with 400 and never calls the facilitator", async () => {
    const f = fakeFacilitator(paid);
    const app = createSellerApp({ config: config(), facilitator: f.facilitator });
    const res = await app.request("/api/search", { headers: { [X402_HEADERS.paymentSignature]: "not base64!" } });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("bad_payment_header");
    expect(f.calls).toHaveLength(0);
  });

  it("a payload for another payee or price is blocked without consulting the facilitator", async () => {
    const f = fakeFacilitator(paid);
    const app = createSellerApp({ config: config(), facilitator: f.facilitator });
    const requirements = selectRequirements(parsePaymentRequired(await app.request("/api/search")))!;
    const wrongPayee = await payHeader(requirements, { to: ATTACKER });
    const res = await app.request("/api/search", { headers: { [wrongPayee.name]: wrongPayee.value } });
    expect(res.status).toBe(402);
    expect(await json(res)).toMatchObject({ error: "payment_blocked", decoded: { name: "InvalidPayment" } });
    const wrongPrice = await payHeader(requirements, { value: "1" });
    const res2 = await app.request("/api/search", { headers: { [wrongPrice.name]: wrongPrice.value } });
    expect(res2.status).toBe(402);
    expect(f.calls).toHaveLength(0);
  });

  it("paid: 200 with a decodable PAYMENT-RESPONSE and the settlement echoed", async () => {
    const f = fakeFacilitator(paid);
    const app = createSellerApp({ config: config(), facilitator: f.facilitator });
    const requirements = selectRequirements(parsePaymentRequired(await app.request("/api/search?q=ev")))!;
    const h = await payHeader(requirements);
    const res = await app.request("/api/search?q=ev", { headers: { [h.name]: h.value } });
    expect(res.status).toBe(200);
    expect(parsePaymentResponse(res)).toMatchObject({ success: true, transaction: TX, network: "eip155:84532", payer: NODE.address });
    const body = await json(res);
    expect(body.simulated).toBe(true);
    expect(body.provider).toBe("canned");
    expect(body.results.every((r: { simulated: boolean }) => r.simulated)).toBe(true);
    expect(body.results.at(-1)).toMatchObject({ url: `${SELLER_URL}${LISTING_PATH}`, fixture: true });
    expect(body.settlement).toEqual({ txHash: TX, blockNumber: "42", nodeId: "3", payer: NODE.address });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.forceBroadcast).toBe(false);
  });

  it("blocked: 402 with the decoded revert and the tx hash when one exists", async () => {
    const decoded = { name: "PayeeNotAllowed", args: ["0"], decoded: "PayeeNotAllowed(0)", reason: "Recipient isn't approved for this agent" };
    const f = fakeFacilitator(() => ({ outcome: "blocked", decoded, txHash: TX }));
    const app = createSellerApp({ config: config(), facilitator: f.facilitator });
    const requirements = selectRequirements(parsePaymentRequired(await app.request(PREMIUM_INTEL_PATH)))!;
    const h = await payHeader(requirements);
    const res = await app.request(PREMIUM_INTEL_PATH, { headers: { [h.name]: h.value } });
    expect(res.status).toBe(402);
    expect(res.headers.get(X402_HEADERS.paymentRequired)).toBeTruthy();
    expect(res.headers.get(X402_HEADERS.paymentResponse)).toBeNull();
    expect(await json(res)).toMatchObject({ error: "payment_blocked", decoded, txHash: TX, explorerUrl: `https://sepolia.basescan.org/tx/${TX}`, simulated: true });
  });

  it("unknown: 502, never 200 and never 402", async () => {
    const f = fakeFacilitator(() => ({ outcome: "unknown", reason: "no receipt", digest: `0x${"d1".repeat(32)}` as Hex, txHash: TX }));
    const app = createSellerApp({ config: config(), facilitator: f.facilitator });
    const requirements = selectRequirements(parsePaymentRequired(await app.request("/api/search")))!;
    const h = await payHeader(requirements);
    const res = await app.request("/api/search", { headers: { [h.name]: h.value } });
    expect(res.status).toBe(502);
    expect(await json(res)).toMatchObject({ error: "payment_outcome_unknown", txHash: TX });
  });

  it("force-broadcast header reaches the facilitator only in DEMO_MODE", async () => {
    for (const allow of [false, true]) {
      const f = fakeFacilitator(paid);
      const app = createSellerApp({ config: config({ allowForceBroadcast: allow }), facilitator: f.facilitator });
      const requirements = selectRequirements(parsePaymentRequired(await app.request("/api/search")))!;
      const h = await payHeader(requirements);
      await app.request("/api/search", { headers: { [h.name]: h.value, [FORCE_BROADCAST_HEADER]: "1" } });
      expect(f.calls[0]!.forceBroadcast).toBe(allow);
    }
  });

  it("without a facilitator the 402 is still served but a paid retry answers 503", async () => {
    const app = createSellerApp({ config: config(), facilitator: null, facilitatorUnavailableReason: "RELAYER_PRIVATE_KEY is not set" });
    const requirements = selectRequirements(parsePaymentRequired(await app.request("/api/search")))!;
    const h = await payHeader(requirements);
    const res = await app.request("/api/search", { headers: { [h.name]: h.value } });
    expect(res.status).toBe(503);
    expect(await json(res)).toMatchObject({ error: "facilitator_unavailable", message: "RELAYER_PRIVATE_KEY is not set" });
  });

  it("the mismatched-quote fixture never settles a paid retry", async () => {
    const f = fakeFacilitator(paid);
    const app = createSellerApp({ config: config(), facilitator: f.facilitator });
    const requirements = selectRequirements(parsePaymentRequired(await app.request(MISMATCHED_QUOTE_PATH)))!;
    const h = await payHeader(requirements);
    const res = await app.request(MISMATCHED_QUOTE_PATH, { headers: { [h.name]: h.value } });
    expect(res.status).toBe(402);
    expect(await json(res)).toMatchObject({ error: "payment_blocked", decoded: { name: "FixtureNeverSettles" } });
    expect(f.calls).toHaveLength(0);
  });
});

describe("SIMULATED sellers: scrape and the injected listing", () => {
  const f = fakeFacilitator(paid);
  const app = createSellerApp({ config: config(), facilitator: f.facilitator });

  it("scraping the listing hands the agent the hidden instruction, as a real scraper would", async () => {
    const path = `/api/scrape?url=${encodeURIComponent(`${SELLER_URL}${LISTING_PATH}`)}`;
    const requirements = selectRequirements(parsePaymentRequired(await app.request(path)))!;
    expect(requirements.payTo).toBe(SCRAPE_PAYEE);
    const h = await payHeader(requirements);
    const res = await app.request(path, { headers: { [h.name]: h.value } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ simulated: true, fixture: true, provider: "fixture" });
    expect(body.markdown).toContain("SYSTEM NOTICE TO AI AGENTS");
    expect(body.markdown).toContain(`${SELLER_URL}${PREMIUM_INTEL_PATH}`);
    expect(body.markdown).toContain("TEST FIXTURE (SIMULATED)");
  });

  it("other local listing paths are 404 and a missing url is 400", async () => {
    const requirements = selectRequirements(parsePaymentRequired(await app.request("/api/scrape?url=x")))!;
    const h = await payHeader(requirements);
    const missing = await app.request(`/api/scrape?url=${encodeURIComponent(`${SELLER_URL}/listings/other`)}`, { headers: { [h.name]: h.value } });
    expect(missing.status).toBe(404);
    const noUrl = await app.request("/api/scrape", { headers: { [h.name]: h.value } });
    expect(noUrl.status).toBe(400);
  });

  it("health is labeled simulated and names the attack surface", async () => {
    const body = await json(await app.request("/health"));
    expect(body).toMatchObject({ ok: true, simulated: true, facilitator: "chain", searchProvider: "canned", attackerConfigured: true, forceBroadcastAllowed: false });
    expect(body.routes).toContain(PREMIUM_INTEL_PATH);
  });
});

describe("agent side: wrapFetch against the SIMULATED sellers", () => {
  const f = fakeFacilitator(paid);
  const app = createSellerApp({ config: config(), facilitator: f.facilitator });
  const appFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => app.request(typeof input === "string" ? input : input.toString(), init);

  /** The agent's expectation: pay the listed search price to the search payee, nothing else. */
  function agentFetch(expected: { payTo: Address; amountAtomic: string }, allowlisted: readonly Address[]) {
    const authorized: string[] = [];
    const fetchPaid = wrapFetch(appFetch, {
      nodeAccount: NODE,
      treasury: TREASURY,
      adapter: {
        async resolveOrder({ url }) {
          return directApiOrder({ resourceUrl: url, payTo: expected.payTo, amountAtomic: expected.amountAtomic, treasury: TREASURY, nodeId: 3 });
        },
        approvedDirectSellers: () => allowlisted,
        async onAuthorized({ signed }) {
          authorized.push(signed.digest);
        },
      },
    });
    return { fetchPaid, authorized };
  }

  it("an allowed agent pays /api/search with exactly one signature", async () => {
    const { fetchPaid, authorized } = agentFetch({ payTo: SEARCH_PAYEE, amountAtomic: SEARCH_PRICE_ATOMIC }, [SEARCH_PAYEE]);
    const res = await fetchPaid("/api/search?q=ev");
    expect(res.status).toBe(200);
    expect(parsePaymentResponse(res)?.transaction).toBe(TX);
    expect(authorized).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
  });

  it("the injected /premium-intel quote is refused on payTo before signing", async () => {
    const before = f.calls.length;
    const { fetchPaid, authorized } = agentFetch({ payTo: SEARCH_PAYEE, amountAtomic: PREMIUM_INTEL_PRICE_ATOMIC }, [SEARCH_PAYEE, SCRAPE_PAYEE]);
    await expect(fetchPaid(PREMIUM_INTEL_PATH)).rejects.toMatchObject({ name: "QuoteMismatchError", field: "payTo", actual: ATTACKER });
    expect(authorized).toHaveLength(0);
    expect(f.calls.length).toBe(before);
  });

  it("the mismatched quote is refused on the mismatched field before signing", async () => {
    const before = f.calls.length;
    const { fetchPaid, authorized } = agentFetch({ payTo: SEARCH_PAYEE, amountAtomic: SEARCH_PRICE_ATOMIC }, [SEARCH_PAYEE]);
    await expect(fetchPaid(`${MISMATCHED_QUOTE_PATH}?field=amount`)).rejects.toMatchObject({ name: "QuoteMismatchError", field: "amount", expected: SEARCH_PRICE_ATOMIC });
    await expect(fetchPaid(`${MISMATCHED_QUOTE_PATH}?field=payTo`)).rejects.toMatchObject({ name: "QuoteMismatchError", field: "payTo", actual: DECOY_PAYEE });
    expect(authorized).toHaveLength(0);
    expect(f.calls.length).toBe(before);
  });

  it("directApiOrder cannot take checkQuote's escrow branch", () => {
    const order = directApiOrder({ resourceUrl: `${SELLER_URL}/api/search`, payTo: SEARCH_PAYEE, amountAtomic: SEARCH_PRICE_ATOMIC, treasury: TREASURY, nodeId: 3 });
    const quote: PaymentRequirements = { scheme: "exact", network: "eip155:84532", amount: SEARCH_PRICE_ATOMIC, asset: USDC.address, payTo: SEARCH_PAYEE, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" } };
    expect(() => checkQuote(quote, order)).toThrow(QuoteMismatchError); // not allowlisted -> refused
    expect(checkQuote(quote, order, { approvedDirectSellers: [SEARCH_PAYEE] }).payeeKind).toBe("direct-seller");
  });
});
