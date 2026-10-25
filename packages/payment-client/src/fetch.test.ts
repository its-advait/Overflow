import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import type { PurchaseOrder } from "@overflow/schemas";
import {
  PaymentOutcomeUnknownError,
  QuoteMismatchError,
  encodeBase64Json,
  parsePaymentPayload,
  wrapFetch,
  type PaymentFetchAdapter,
  type PaymentRequirements,
} from "./index";
import { ESCROW, TREASURY, makeOrder, makeRequirements } from "./test-fixtures";

const NOW = 1_800_000_000;
const URL_ = "https://seller.example/dataset.csv";

function paymentRequired(accepts: PaymentRequirements[], error?: string) {
  return encodeBase64Json({ x402Version: 2, ...(error ? { error } : {}), resource: { url: URL_ }, accepts });
}

function response(status: number, headers: Record<string, string> = {}, body = "") {
  return new Response(body, { status, headers });
}

type Call = { input: string | URL; init?: RequestInit };

/** A SIMULATED seller: first call 402s, the paid call returns `paid`. */
function sellerFetch(first: Response, paid: Response | (() => Promise<Response>)) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push({ input, init });
    if (calls.length === 1) return first;
    return typeof paid === "function" ? paid() : paid;
  });
  return { impl, calls };
}

function setup(adapterOverrides: Partial<PaymentFetchAdapter> = {}, order: PurchaseOrder | null = makeOrder()) {
  const nodeAccount = privateKeyToAccount(generatePrivateKey());
  const events: string[] = [];
  const adapter: PaymentFetchAdapter = {
    resolveOrder: async () => {
      events.push("resolveOrder");
      return order;
    },
    onAuthorized: async () => {
      events.push("onAuthorized");
    },
    onPaymentResult: async (ctx) => {
      events.push(`onPaymentResult:${ctx.status}:${ctx.settlement?.success ?? "none"}`);
    },
    ...adapterOverrides,
  };
  return { nodeAccount, adapter, events };
}

describe("wrapFetch", () => {
  it("passes non-402 responses through without touching the adapter", async () => {
    const { nodeAccount, adapter, events } = setup();
    const ok = response(200, {}, "hello");
    const fetchImpl = vi.fn(async () => ok);
    const paid = wrapFetch(fetchImpl, { nodeAccount, treasury: TREASURY, adapter, now: () => NOW });
    expect(await paid(URL_)).toBe(ok);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it("pays a matching 402 once: signs from = treasury, sends PAYMENT-SIGNATURE, reports the settlement", async () => {
    const { nodeAccount, adapter, events } = setup();
    const settlement = encodeBase64Json({ success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:84532", payer: TREASURY });
    const seller = sellerFetch(
      response(402, { "PAYMENT-REQUIRED": paymentRequired([makeRequirements()]) }),
      response(200, { "PAYMENT-RESPONSE": settlement }, "the,data"),
    );
    const paid = wrapFetch(seller.impl, { nodeAccount, treasury: TREASURY, adapter, now: () => NOW });
    const res = await paid(URL_, { method: "POST", body: "q", headers: { "x-trace": "1" } });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("the,data");
    expect(seller.calls).toHaveLength(2);
    const second = seller.calls[1]!;
    expect(second.init?.method).toBe("POST");
    expect(second.init?.body).toBe("q");
    const headers = new Headers(second.init?.headers);
    expect(headers.get("x-trace")).toBe("1");
    const payload = parsePaymentPayload(headers.get("PAYMENT-SIGNATURE")!);
    expect(payload.accepted).toEqual(makeRequirements());
    expect(payload.resource?.url).toBe(URL_);
    expect(payload.payload.authorization.from).toBe(TREASURY);
    expect(payload.payload.authorization.to).toBe(ESCROW);
    expect(payload.payload.authorization.value).toBe("8400000");
    expect(payload.payload.authorization.validAfter).toBe(String(NOW - 5));
    expect(payload.payload.authorization.validBefore).toBe(String(NOW + 60)); // maxTimeoutSeconds
    expect(events).toEqual(["resolveOrder", "onAuthorized", "onPaymentResult:200:true"]);
  });

  it("onAuthorized sees the digest before the paid request is sent", async () => {
    const order = makeOrder();
    let digestAtAuthorize: string | undefined;
    let callsWhenAuthorized = 0;
    const seller = sellerFetch(
      response(402, { "PAYMENT-REQUIRED": paymentRequired([makeRequirements()]) }),
      response(200),
    );
    const { nodeAccount, adapter } = setup({
      onAuthorized: async (ctx) => {
        digestAtAuthorize = ctx.signed.digest;
        callsWhenAuthorized = seller.calls.length;
        expect(ctx.order).toEqual(order);
        expect(ctx.header.name).toBe("PAYMENT-SIGNATURE");
        expect(ctx.quote.payTo).toBe(ESCROW);
      },
    }, order);
    await wrapFetch(seller.impl, { nodeAccount, treasury: TREASURY, adapter, now: () => NOW })(URL_);
    expect(digestAtAuthorize).toMatch(/^0x[0-9a-f]{64}$/);
    expect(callsWhenAuthorized).toBe(1);
  });

  it("never signs when checkQuote fails: throws QuoteMismatch and sends no second request", async () => {
    const { nodeAccount, adapter, events } = setup();
    const attacker = "0x6666666666666666666666666666666666666666";
    const seller = sellerFetch(
      response(402, { "PAYMENT-REQUIRED": paymentRequired([makeRequirements({ payTo: attacker })]) }),
      response(200),
    );
    const signSpy = vi.spyOn(nodeAccount, "signTypedData");
    const paid = wrapFetch(seller.impl, { nodeAccount, treasury: TREASURY, adapter, now: () => NOW });
    await expect(paid(URL_)).rejects.toBeInstanceOf(QuoteMismatchError);
    expect(signSpy).not.toHaveBeenCalled();
    expect(seller.calls).toHaveLength(1);
    expect(events).toEqual(["resolveOrder"]);
  });

  it("rejects an amount that differs from the order even by one atomic unit", async () => {
    const { nodeAccount, adapter } = setup();
    const seller = sellerFetch(
      response(402, { "PAYMENT-REQUIRED": paymentRequired([makeRequirements({ amount: "8400001" })]) }),
      response(200),
    );
    await expect(wrapFetch(seller.impl, { nodeAccount, treasury: TREASURY, adapter, now: () => NOW })(URL_)).rejects.toMatchObject({
      name: "QuoteMismatchError",
      field: "amount",
    });
    expect(seller.calls).toHaveLength(1);
  });

  it("returns the 402 unpaid when no accepts entry is exact on Base Sepolia, or the adapter has no order", async () => {
    const first = response(402, { "PAYMENT-REQUIRED": paymentRequired([makeRequirements({ network: "eip155:8453" })]) });
    const { nodeAccount, adapter, events } = setup();
    const seller = sellerFetch(first, response(200));
    expect(await wrapFetch(seller.impl, { nodeAccount, treasury: TREASURY, adapter, now: () => NOW })(URL_)).toBe(first);
    expect(events).toEqual([]);

    const first2 = response(402, { "PAYMENT-REQUIRED": paymentRequired([makeRequirements()]) });
    const s2 = setup({}, null);
    const seller2 = sellerFetch(first2, response(200));
    expect(await wrapFetch(seller2.impl, { nodeAccount: s2.nodeAccount, treasury: TREASURY, adapter: s2.adapter, now: () => NOW })(URL_)).toBe(first2);
    expect(seller2.calls).toHaveLength(1);
    expect(s2.events).toEqual(["resolveOrder"]);
  });

  it("a 402 without PAYMENT-REQUIRED is a parse error, not a payment", async () => {
    const { nodeAccount, adapter } = setup();
    const seller = sellerFetch(response(402, {}, '{"x402Version":2}'), response(200));
    await expect(wrapFetch(seller.impl, { nodeAccount, treasury: TREASURY, adapter, now: () => NOW })(URL_)).rejects.toThrow(/missing PAYMENT-REQUIRED/);
    expect(seller.calls).toHaveLength(1);
  });

  it("pays an approved direct seller only through the adapter's allowlist", async () => {
    const order = makeOrder();
    const quote = makeRequirements({ payTo: order.sellerAddress });
    const s1 = setup({}, order);
    const seller1 = sellerFetch(response(402, { "PAYMENT-REQUIRED": paymentRequired([quote]) }), response(200));
    await expect(wrapFetch(seller1.impl, { nodeAccount: s1.nodeAccount, treasury: TREASURY, adapter: s1.adapter, now: () => NOW })(URL_)).rejects.toBeInstanceOf(QuoteMismatchError);

    const s2 = setup({ approvedDirectSellers: () => [order.sellerAddress] }, order);
    const seller2 = sellerFetch(response(402, { "PAYMENT-REQUIRED": paymentRequired([quote]) }), response(200));
    const res = await wrapFetch(seller2.impl, { nodeAccount: s2.nodeAccount, treasury: TREASURY, adapter: s2.adapter, now: () => NOW })(URL_);
    expect(res.status).toBe(200);
    const payload = parsePaymentPayload(new Headers(seller2.calls[1]!.init?.headers).get("PAYMENT-SIGNATURE")!);
    expect(payload.payload.authorization.to).toBe(order.sellerAddress);
  });

  it("caps validBefore at the reservation window", async () => {
    const { nodeAccount, adapter } = setup();
    const seller = sellerFetch(
      response(402, { "PAYMENT-REQUIRED": paymentRequired([makeRequirements({ maxTimeoutSeconds: 3600 })]) }),
      response(200),
    );
    await wrapFetch(seller.impl, { nodeAccount, treasury: TREASURY, adapter, now: () => NOW, reservationWindowSeconds: 300 })(URL_);
    const payload = parsePaymentPayload(new Headers(seller.calls[1]!.init?.headers).get("PAYMENT-SIGNATURE")!);
    expect(payload.payload.authorization.validBefore).toBe(String(NOW + 300));
  });

  it("a failed paid response is reported once and never retried", async () => {
    const { nodeAccount, adapter, events } = setup();
    const failure = encodeBase64Json({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" });
    const seller = sellerFetch(
      response(402, { "PAYMENT-REQUIRED": paymentRequired([makeRequirements()]) }),
      response(402, { "PAYMENT-RESPONSE": failure, "PAYMENT-REQUIRED": paymentRequired([makeRequirements()], "payment failed") }),
    );
    const res = await wrapFetch(seller.impl, { nodeAccount, treasury: TREASURY, adapter, now: () => NOW })(URL_);
    expect(res.status).toBe(402);
    expect(seller.calls).toHaveLength(2);
    expect(events).toEqual(["resolveOrder", "onAuthorized", "onPaymentResult:402:false"]);
  });

  it("a network error after sending the authorization is PaymentOutcomeUnknown with the digest; no retry", async () => {
    let digest: string | undefined;
    const { nodeAccount, adapter, events } = setup({
      onAuthorized: async (ctx) => {
        digest = ctx.signed.digest;
      },
    });
    const seller = sellerFetch(
      response(402, { "PAYMENT-REQUIRED": paymentRequired([makeRequirements()]) }),
      async () => {
        throw new TypeError("socket hang up");
      },
    );
    const paid = wrapFetch(seller.impl, { nodeAccount, treasury: TREASURY, adapter, now: () => NOW });
    const err = await paid(URL_).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentOutcomeUnknownError);
    expect((err as PaymentOutcomeUnknownError).digest).toBe(digest);
    expect(seller.calls).toHaveLength(2);
    expect(events).toEqual(["resolveOrder", "onPaymentResult:null:none"]);
  });

  it("a malformed PAYMENT-RESPONSE is reported as an error with settlement null, not as failure", async () => {
    const seen: unknown[] = [];
    const { nodeAccount, adapter } = setup({
      onPaymentResult: async (ctx) => {
        seen.push(ctx);
      },
    });
    const seller = sellerFetch(
      response(402, { "PAYMENT-REQUIRED": paymentRequired([makeRequirements()]) }),
      response(200, { "PAYMENT-RESPONSE": btoa("{}") }),
    );
    await wrapFetch(seller.impl, { nodeAccount, treasury: TREASURY, adapter, now: () => NOW })(URL_);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 200, settlement: null });
    expect((seen[0] as { error?: unknown }).error).toBeDefined();
  });
});
