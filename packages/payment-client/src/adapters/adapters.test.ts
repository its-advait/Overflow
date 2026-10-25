import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { USDC, type PurchaseOrder } from "@overflow/schemas";
import { recoverAuthorizationSigner } from "../typed-data";
import { CoinbaseFacilitatorAdapter } from "./coinbase";
import { OverflowFacilitatorAdapter } from "./overflow";
import { MemoryPurchaseStore } from "./store";
import { AlreadySubmittedError, AuthorizationInFlightError, QuoteMismatchError, type AdapterChainReader, type PaymentRequirements } from "./types";
import { b64decode, b64encode, fetchPaymentRequirements, NoAcceptableQuoteError } from "./x402";

const NODE = privateKeyToAccount(`0x${"a11ce".padStart(64, "0")}`);
const TREASURY = "0xd3A74fA991CA0B5627d30EF27dC699C134848291" as const;
const ESCROW = "0x1111111111111111111111111111111111111111" as const;
const SELLER = "0x2222222222222222222222222222222222222222" as const;
const H = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as const;
const SERVICE = "http://service.test";
const RESOURCE = "http://seller.test/r/1";
const T0 = new Date("2026-10-24T12:00:00Z");

function order(path: PurchaseOrder["paymentPath"], id = "p1"): PurchaseOrder {
  return {
    id,
    orderIdBytes32: H(9),
    missionId: "m1",
    resourceId: "r1",
    buyerTreasury: TREASURY,
    sellerAddress: SELLER,
    escrowAddress: ESCROW,
    chainId: 84532,
    tokenAddress: USDC.address,
    amountAtomic: "50000",
    payingNodeId: 1,
    participatingAgentIds: ["a1"],
    allocations: [],
    resourceManifestHash: H(8),
    termsHash: H(7),
    paymentPath: path,
    txHashes: [],
    createdAt: T0.toISOString(),
    authorizationExpiresAt: new Date(T0.getTime() + 3600_000).toISOString(),
    status: "PROPOSED",
  };
}
const quote = (payTo: `0x${string}` = ESCROW, over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "eip155:84532",
  asset: USDC.address,
  payTo,
  amount: "50000",
  maxTimeoutSeconds: 300,
  resource: RESOURCE,
  ...over,
});

type Call = { url: string; method: string; body?: Record<string, unknown>; headers: Record<string, string> };
type Route = (call: Call) => Response | Promise<Response> | "hang";
function fakeFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    const call: Call = { url, method: init?.method ?? "GET", headers, ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) };
    calls.push(call);
    const key = `${call.method} ${new URL(url).pathname}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ ok: false, error: { name: "NotFound" } }), { status: 404 });
    const out = await route(call);
    if (out === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    return out;
  };
  return { fetchFn, calls, of: (key: string) => calls.filter((c) => `${c.method} ${new URL(c.url).pathname}` === key) };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const paymentRequired = (payTo: `0x${string}` = ESCROW) => json({ x402Version: 2, error: "payment required", resource: { url: RESOURCE }, accepts: [quote(payTo)] }, 402);

type FakeChain = AdapterChainReader & { used: boolean };
function chain(over: Partial<AdapterChainReader> = {}): FakeChain {
  const c: FakeChain = {
    used: false,
    authorizationState: async () => c.used,
    getTransactionReceipt: async () => null,
    ...over,
  };
  return c;
}

function setup(path: PurchaseOrder["paymentPath"], routes: Record<string, Route>, chainOver: Partial<AdapterChainReader> = {}) {
  const store = new MemoryPurchaseStore([order(path)]);
  const ff = fakeFetch(routes);
  const c = chain(chainOver);
  let now = T0;
  const deps = {
    store,
    signerForNode: async (nodeId: number) => {
      if (nodeId !== 1) throw new Error("unknown node");
      return NODE;
    },
    chain: c,
    fetch: ff.fetchFn,
    serviceUrl: SERVICE,
    now: () => now,
    requestTimeoutMs: 50,
  };
  const adapter = path === "overflow-facilitator" ? new OverflowFacilitatorAdapter(deps) : new CoinbaseFacilitatorAdapter(deps);
  return { adapter, store, ff, chain: c, advance: (sec: number) => (now = new Date(now.getTime() + sec * 1000)) };
}

describe("x402 quote parsing", () => {
  it("reads the 402 body or the PAYMENT-REQUIRED header and picks the exact Base Sepolia USDC quote", async () => {
    const ff = fakeFetch({ "GET /r/1": () => paymentRequired() });
    const q = await fetchPaymentRequirements(ff.fetchFn, RESOURCE);
    expect(q).toMatchObject({ payTo: ESCROW, amount: "50000", asset: USDC.address, resource: RESOURCE });
    const viaHeader = fakeFetch({ "GET /r/1": () => new Response("", { status: 402, headers: { "payment-required": b64encode({ x402Version: 2, accepts: [{ ...quote(), network: "eip155:1" }, quote(SELLER)] }) } }) });
    expect((await fetchPaymentRequirements(viaHeader.fetchFn, RESOURCE)).payTo).toBe(SELLER);
  });
  it("refuses a non-402 answer and quotes on other networks or assets", async () => {
    await expect(fetchPaymentRequirements(fakeFetch({ "GET /r/1": () => json({ data: 1 }) }).fetchFn, RESOURCE)).rejects.toBeInstanceOf(NoAcceptableQuoteError);
    const other = fakeFetch({ "GET /r/1": () => json({ x402Version: 2, accepts: [{ ...quote(), asset: "0x3333333333333333333333333333333333333333" }] }, 402) });
    await expect(fetchPaymentRequirements(other.fetchFn, RESOURCE)).rejects.toThrow(/no exact/);
  });
});

describe("preparePayment (both adapters share it)", () => {
  it("signs one EIP-3009 authorization from the treasury with the paying node key and moves PROPOSED -> RESERVED", async () => {
    const { adapter, store } = setup("overflow-facilitator", { "GET /r/1": () => paymentRequired() });
    const p = await adapter.preparePayment("p1", quote());
    expect(p.authorization).toMatchObject({ from: TREASURY, to: ESCROW, value: "50000" });
    expect(Number(p.authorization.validBefore)).toBe(Math.floor(T0.getTime() / 1000) + 300);
    expect(await recoverAuthorizationSigner(p.authorization, p.signature)).toBe(NODE.address);
    expect((await store.getOrder("p1"))!.status).toBe("RESERVED");
    expect((await store.getOrder("p1"))!.authorizationDigest).toBe(p.digest);
    await expect(adapter.preparePayment("p1", quote())).rejects.toBeInstanceOf(AuthorizationInFlightError);
    expect((await store.getPrepared("p1"))!.digest).toBe(p.digest);
  });
  it("refuses a quote whose payTo, amount, asset or network differs from the order, and signs nothing", async () => {
    const { adapter, store } = setup("overflow-facilitator", {});
    for (const bad of [
      quote("0x3333333333333333333333333333333333333333"),
      quote(ESCROW, { amount: "50001" }),
      quote(ESCROW, { asset: "0x3333333333333333333333333333333333333333" }),
    ]) {
      await expect(adapter.preparePayment("p1", bad)).rejects.toBeInstanceOf(QuoteMismatchError);
    }
    expect(await store.getPrepared("p1")).toBeUndefined();
    expect((await store.getOrder("p1"))!.status).toBe("PROPOSED");
  });
  it("the Coinbase path keeps validBefore inside the reservation window", async () => {
    const { adapter } = setup("coinbase-facilitator", {});
    const p = await adapter.preparePayment("p1", quote(SELLER, { maxTimeoutSeconds: 3600 }));
    expect(Number(p.authorization.validBefore) - Math.floor(T0.getTime() / 1000)).toBe(570);
  });
});

describe("OverflowFacilitatorAdapter", () => {
  it("submit: POSTs the stored authorization to /settle, maps success to ESCROW_FUNDED, never submits twice", async () => {
    const { adapter, store, ff } = setup("overflow-facilitator", {
      "POST /settle": () => json({ success: true, transaction: H(1), nodeId: "1", digest: H(5) }),
    });
    const p = await adapter.preparePayment("p1", quote());
    const s = await adapter.submitPayment("p1");
    expect(s).toMatchObject({ status: "ESCROW_FUNDED", txHash: H(1), digest: p.digest, path: "overflow-facilitator" });
    expect(s.explorerUrl).toContain(H(1));
    const body = ff.of("POST /settle")[0]!.body as { paymentPayload: { payload: { authorization: unknown; signature: string } } };
    expect(body.paymentPayload.payload.authorization).toEqual(p.authorization);
    expect(body.paymentPayload.payload.signature).toBe(p.signature);
    expect((await store.getOrder("p1"))!.txHashes).toEqual([H(1)]);
    await expect(adapter.submitPayment("p1")).rejects.toBeInstanceOf(AlreadySubmittedError);
    await expect(adapter.preparePayment("p1", quote())).rejects.toBeInstanceOf(AuthorizationInFlightError);
    expect(ff.of("POST /settle")).toHaveLength(1);
  });
  it("submit: a decoded policy revert is REJECTED with its error; a 409 replays the original result", async () => {
    const rejected = setup("overflow-facilitator", {
      "POST /settle": () => json({ success: false, errorReason: "Recipient is not approved for anyone", decoded: { name: "PayeeNotAllowed", args: ["0"] } }),
    });
    await rejected.adapter.preparePayment("p1", quote());
    expect(await rejected.adapter.submitPayment("p1")).toMatchObject({ status: "REJECTED", decodedRevert: "PayeeNotAllowed(0)" });

    const replay = setup("overflow-facilitator", {
      "POST /settle": () => json({ ok: false, error: { name: "AlreadySubmitted" }, original: { status: "done", txHash: H(2), result: { success: true, transaction: H(2) } } }, 409),
    });
    await replay.adapter.preparePayment("p1", quote());
    expect(await replay.adapter.submitPayment("p1")).toMatchObject({ status: "ESCROW_FUNDED", txHash: H(2) });
  });
  it("timeout after broadcast: PAYMENT_UNKNOWN, then reconcile finds the used nonce and the hash without a new authorization", async () => {
    let settleCalls = 0;
    const { adapter, store, ff, chain } = setup("overflow-facilitator", {
      "POST /settle": () => {
        settleCalls++;
        if (settleCalls === 1) return "hang"; // the relayer broadcast, but our connection timed out
        return json({ ok: false, error: { name: "AlreadySubmitted" }, original: { status: "done", txHash: H(3), result: { success: true, transaction: H(3) } } }, 409);
      },
    });
    const p = await adapter.preparePayment("p1", quote());
    const s = await adapter.submitPayment("p1");
    expect(s.status).toBe("PAYMENT_UNKNOWN");
    expect(s.reason).toMatch(/unreachable after submit.*timeout.*do not resign/);
    await expect(adapter.submitPayment("p1")).rejects.toBeInstanceOf(AlreadySubmittedError);

    chain.used = true; // USDC consumed the nonce
    const st = await adapter.reconcilePayment("p1");
    expect(st).toMatchObject({ status: "ESCROW_FUNDED", authorizationUsed: true, txHash: H(3), authorizationDigest: p.digest, nonce: p.authorization.nonce });
    expect((await store.getOrder("p1"))!.status).toBe("ESCROW_FUNDED");
    // every /settle call carried the same digest: no second authorization was ever created
    const digests = ff.of("POST /settle").map((c) => (c.body as { paymentPayload: { payload: { authorization: { nonce: string } } } }).paymentPayload.payload.authorization.nonce);
    expect(new Set(digests)).toEqual(new Set([p.authorization.nonce]));
    expect((await store.getPrepared("p1"))!.digest).toBe(p.digest);
  });
  it("reconcile: unused and expired -> FAILED_BEFORE_FUNDING; unused and live -> unchanged; reverted receipt after UNKNOWN -> FAILED_BEFORE_FUNDING", async () => {
    const { adapter, advance } = setup("overflow-facilitator", { "POST /settle": () => "hang" });
    await adapter.preparePayment("p1", quote());
    await adapter.submitPayment("p1");
    expect((await adapter.reconcilePayment("p1")).status).toBe("PAYMENT_UNKNOWN");
    advance(301);
    const st = await adapter.reconcilePayment("p1");
    expect(st).toMatchObject({ status: "FAILED_BEFORE_FUNDING", authorizationUsed: false });
    expect(st.reason).toMatch(/expired unused/);

    const rev = setup("overflow-facilitator", { "POST /settle": () => json({ success: false, status: "unknown", transaction: H(4), errorReason: "no receipt" }) }, {
      getTransactionReceipt: async () => ({ status: "reverted", blockNumber: 1n }),
    });
    await rev.adapter.preparePayment("p1", quote());
    expect((await rev.adapter.submitPayment("p1")).status).toBe("PAYMENT_UNKNOWN");
    expect(await rev.adapter.reconcilePayment("p1")).toMatchObject({ status: "FAILED_BEFORE_FUNDING", txHash: H(4), authorizationUsed: false });
  });
  it("reconcile without an authorization or on a terminal purchase changes nothing", async () => {
    const { adapter } = setup("overflow-facilitator", {});
    expect(await adapter.reconcilePayment("p1")).toMatchObject({ status: "PROPOSED", reason: "no authorization was ever prepared" });
  });
});

describe("CoinbaseFacilitatorAdapter", () => {
  const sellerOk = (call: Call) => {
    const payload = b64decode<{ payload: { authorization: { to: string; value: string } } }>(call.headers["payment-signature"]!);
    expect(payload.payload.authorization).toMatchObject({ to: SELLER, value: "50000" });
    return json({ data: "the resource" }, 200, { "payment-response": b64encode({ success: true, transaction: H(11), network: "eip155:84532" }) });
  };
  it("submit: /reserve first, then the x402 payload to the seller, whose PAYMENT-RESPONSE carries the settle hash", async () => {
    const { adapter, store, ff } = setup("coinbase-facilitator", {
      "POST /reserve": () => json({ success: true, transaction: H(10), reservedDigest: H(5) }),
      "GET /r/1": (c) => (c.headers["payment-signature"] ? sellerOk(c) : paymentRequired(SELLER)),
    });
    const p = await adapter.preparePayment("p1", quote(SELLER));
    const s = await adapter.submitPayment("p1");
    expect(s).toMatchObject({ status: "ESCROW_FUNDED", txHash: H(11), digest: p.digest, path: "coinbase-facilitator" });
    expect(ff.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["POST /reserve", "GET /r/1"]);
    expect((await store.getOrder("p1"))!.txHashes).toEqual([H(10), H(11)]);
  });
  it("submit: a reserve policy revert is REJECTED and the seller is never contacted", async () => {
    const { adapter, ff } = setup("coinbase-facilitator", {
      "POST /reserve": () => json({ success: false, errorReason: "Agent 1 or an ancestor would pass its cap", decoded: { name: "OverBudget", args: ["1"] } }),
      "GET /r/1": () => json({}, 500),
    });
    await adapter.preparePayment("p1", quote(SELLER));
    expect(await adapter.submitPayment("p1")).toMatchObject({ status: "REJECTED", decodedRevert: "OverBudget(1)" });
    expect(ff.of("GET /r/1")).toHaveLength(0);
  });
  it("seller rejects: stays PAYMENT_PENDING while the reservation lives; after validBefore reconcile releases and restores allowance", async () => {
    const { adapter, ff, advance } = setup("coinbase-facilitator", {
      "POST /reserve": () => json({ success: true, transaction: H(10) }),
      "GET /r/1": () => json({ x402Version: 2, error: "invalid_exact_evm_signature" }, 402),
      "POST /release": () => json({ ok: true, released: true, refunded: true, transaction: H(12) }),
    });
    await adapter.preparePayment("p1", quote(SELLER));
    const s = await adapter.submitPayment("p1");
    expect(s.status).toBe("PAYMENT_PENDING");
    expect(s.reason).toMatch(/rejected the payment: invalid_exact_evm_signature/);
    expect((await adapter.reconcilePayment("p1")).status).toBe("PAYMENT_PENDING");
    expect(ff.of("POST /release")).toHaveLength(0);
    advance(600);
    const st = await adapter.reconcilePayment("p1");
    expect(st).toMatchObject({ status: "FAILED_BEFORE_FUNDING", authorizationUsed: false, txHash: H(12) });
    expect(st.reason).toMatch(/allowance restored/);
    expect(ff.of("POST /release")[0]!.body).toEqual({ digest: (await adapter.reconcilePayment("p1")).authorizationDigest });
    expect(ff.of("POST /reserve")).toHaveLength(1);
  });
  it("timeout after reserve: PAYMENT_UNKNOWN, reconcile reads USDC's nonce state, no second reserve or signature", async () => {
    const { adapter, ff, chain, store } = setup("coinbase-facilitator", {
      "POST /reserve": () => json({ success: true, transaction: H(10) }),
      "GET /r/1": (c) => (c.headers["payment-signature"] ? "hang" : paymentRequired(SELLER)),
    });
    const p = await adapter.preparePayment("p1", quote(SELLER));
    const s = await adapter.submitPayment("p1");
    expect(s.status).toBe("PAYMENT_UNKNOWN");
    expect(s.reason).toMatch(/seller unreachable after reserve/);
    expect((await adapter.reconcilePayment("p1")).status).toBe("PAYMENT_UNKNOWN");
    chain.used = true;
    expect(await adapter.reconcilePayment("p1")).toMatchObject({ status: "ESCROW_FUNDED", authorizationUsed: true });
    expect(ff.of("POST /reserve")).toHaveLength(1);
    expect((await store.getPrepared("p1"))!.digest).toBe(p.digest);
    await expect(adapter.submitPayment("p1")).rejects.toBeInstanceOf(AlreadySubmittedError);
  });
  it("prepared but never submitted: after expiry reconcile releases to RELEASED; ReservationLive and NoReservation are handled", async () => {
    let releases = 0;
    const { adapter, advance } = setup("coinbase-facilitator", {
      "POST /release": () => {
        releases++;
        if (releases === 1) return json({ ok: false, released: false, errorReason: "Reservation has not reached validBefore yet", decoded: { name: "ReservationLive", args: [] } });
        return json({ ok: false, released: false, errorReason: "No reservation for this digest", decoded: { name: "NoReservation", args: [] } });
      },
    });
    await adapter.preparePayment("p1", quote(SELLER));
    advance(600);
    expect((await adapter.reconcilePayment("p1")).status).toBe("RESERVED"); // chain clock lags ours
    const st = await adapter.reconcilePayment("p1");
    expect(st.status).toBe("RELEASED");
    expect(st.reason).toMatch(/already released/);
  });
});
