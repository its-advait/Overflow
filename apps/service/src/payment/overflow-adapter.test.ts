import {
  checkQuote,
  encodeBase64Json,
  parsePaymentPayload,
  recoverAuthorizationSigner,
  X402_HEADERS,
  type PaymentRequirements,
} from "@overflow/payment-client";
import { PurchaseOrderSchema, USDC, type Address, type Hex, type PurchaseOrder, type ResourceRecord } from "@overflow/schemas";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { AgentKeys } from "../orchestration/agent-keys.js";
import { createNodeSigners, NoSignerForNodeError } from "./node-signers.js";
import {
  AlreadySubmittedError,
  AuthorizationInFlightError,
  AuthorizationWindowClosedError,
  createOverflowFacilitatorAdapter,
  resourceUrl,
  SellerQuoteError,
  UnknownPreparedPaymentError,
} from "./overflow-adapter.js";

// ---------------------------------------------------------------------------
// No chain, no seller process: a scripted fetch stands in for the SIMULATED
// Recourse seller's paywall and a fake nodeOfKey/authorizationState for the chain.
// ---------------------------------------------------------------------------

const NOW = "2026-10-24T16:00:00.000Z";
const NOW_SEC = Math.floor(new Date(NOW).getTime() / 1000);
const TREASURY = "0x1111111111111111111111111111111111111111" as Address;
const SELLER = "0x2222222222222222222222222222222222222222" as Address;
const ESCROW = "0x3333333333333333333333333333333333333333" as Address;
const b32 = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const TX = b32(0xbeef);
const SELLER_URL = "http://seller.test";

const keys: AgentKeys = {
  root: privateKeyToAccount(`0x${"1".padStart(64, "0")}`),
  rootSource: "test",
  children: {
    research: privateKeyToAccount(`0x${"2".padStart(64, "0")}`),
    finance: privateKeyToAccount(`0x${"3".padStart(64, "0")}`),
    verification: privateKeyToAccount(`0x${"4".padStart(64, "0")}`),
  },
};
/** Chain truth: root is node 1, research node 2, finance node 3; verification has no node. */
const nodeOf = (over: Record<string, bigint> = {}) => {
  const table: Record<string, bigint> = {
    [keys.root.address.toLowerCase()]: 1n,
    [keys.children.research.address.toLowerCase()]: 2n,
    [keys.children.finance.address.toLowerCase()]: 3n,
    ...over,
  };
  return { nodeOfKey: async (k: Address) => table[k.toLowerCase()] ?? 0n };
};

function order(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return PurchaseOrderSchema.parse({
    id: "purchase-1",
    orderIdBytes32: b32(1),
    missionId: "mission-1",
    resourceId: "resource-1",
    buyerTreasury: TREASURY,
    sellerAddress: SELLER,
    escrowAddress: ESCROW,
    chainId: 84532,
    tokenAddress: USDC.address,
    amountAtomic: "12000000",
    payingNodeId: 2,
    participatingAgentIds: ["agent-research"],
    allocations: [],
    resourceManifestHash: b32(5),
    termsHash: b32(9),
    paymentPath: "overflow-facilitator",
    txHashes: [],
    createdAt: NOW,
    authorizationExpiresAt: new Date(new Date(NOW).getTime() + 600_000).toISOString(),
    status: "PROPOSED",
    ...over,
  });
}
const resource = { id: "resource-1", priceAtomic: "12000000", manifestHash: b32(5), simulated: true } as ResourceRecord;

function requirementsFor(o: PurchaseOrder, over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return { scheme: "exact", network: "eip155:84532", amount: o.amountAtomic, asset: USDC.address, payTo: o.escrowAddress, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" }, ...over };
}

type Script = (url: string, init: RequestInit, paid: string | null) => Response | Promise<Response>;

/** A seller whose answer to each request is scripted; records every request it saw. */
function fakeSeller(script: Script) {
  const calls: Array<{ url: string; paid: string | null }> = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    const paid = headers.get(X402_HEADERS.paymentSignature);
    calls.push({ url, paid });
    return script(url, init, paid);
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const r402 = (o: PurchaseOrder, over: Partial<PaymentRequirements> = {}) =>
  json(402, { error: "payment required" }, { [X402_HEADERS.paymentRequired]: encodeBase64Json({ x402Version: 2, resource: { url: resourceUrl(SELLER_URL, o.resourceId, o.orderIdBytes32) }, accepts: [requirementsFor(o, over)] }) });
const r200 = (tx: Hex) =>
  json(200, { simulated: true, delivered: true }, { [X402_HEADERS.paymentResponse]: encodeBase64Json({ success: true, transaction: tx, network: "eip155:84532", payer: TREASURY }) });
const rBlocked = (name: string, args: string[], extra: Record<string, unknown> = {}) =>
  json(402, { error: "payment_blocked", decoded: { name, args, decoded: `${name}(${args.join(",")})`, reason: "treasury policy" }, ...extra });
const rUnknown = () => json(502, { error: "payment_outcome_unknown", digest: b32(7), txHash: TX });

/** Honest seller: 402 to the bare GET, 200 + PAYMENT-RESPONSE to the paid retry. */
const honest = (o: PurchaseOrder): Script => (_u, _i, paid) => (paid ? r200(TX) : r402(o));

function harness(script: Script, over: { authorizationState?: boolean; nodeOf?: Record<string, bigint>; now?: Date; findPaidTx?: (nonce: Hex) => Promise<Hex | null> } = {}) {
  const seller = fakeSeller(script);
  const chainNodes = nodeOf(over.nodeOf);
  const log: string[] = [];
  const nodeSigners = createNodeSigners({ keys, chain: chainNodes, log: (l) => log.push(l) });
  const adapter = createOverflowFacilitatorAdapter({
    sellerUrl: SELLER_URL,
    fetch: seller.fetch,
    treasury: TREASURY,
    nodeSigners,
    chain: { authorizationState: async () => over.authorizationState ?? false, ...(over.findPaidTx ? { findPaidTx: over.findPaidTx } : {}) },
    now: () => over.now ?? new Date(NOW),
    log: (l) => log.push(l),
  });
  return { adapter, seller, log };
}

async function quoted(adapter: ReturnType<typeof harness>["adapter"], o: PurchaseOrder) {
  const requirements = await adapter.getPaymentRequirements(o, resource);
  return checkQuote(requirements, o, { approvedDirectSellers: [] });
}

describe("createOverflowFacilitatorAdapter: quote", () => {
  it("GETs the order's resource URL without a payment header and returns the selected 402 requirements", async () => {
    const o = order();
    const { adapter, seller } = harness(honest(o));
    const req = await adapter.getPaymentRequirements(o, resource);
    expect(seller.calls).toEqual([{ url: `${SELLER_URL}/r/resource-1?order=${b32(1)}`, paid: null }]);
    expect(req.payTo).toBe(ESCROW);
    expect(req.amount).toBe("12000000");
  });
  it.each([
    ["200 instead of 402", () => json(200, { ok: true }), /expected 402.*answered 200/],
    ["402 without PAYMENT-REQUIRED", () => json(402, { error: "nope" }), /PAYMENT-REQUIRED/],
    ["402 offering only another network", (o: PurchaseOrder) => r402(o, { network: "eip155:8453" }), /no exact\/eip155:84532/],
    ["network failure", () => Promise.reject(new TypeError("ECONNREFUSED")), /unreachable/],
  ])("throws SellerQuoteError on %s (route maps it to 502; nothing is signed)", async (_l, script, re) => {
    const o = order();
    const { adapter } = harness(() => (script as (o: PurchaseOrder) => Response | Promise<Response>)(o));
    await expect(adapter.getPaymentRequirements(o, resource)).rejects.toBeInstanceOf(SellerQuoteError);
    await expect(adapter.getPaymentRequirements(o, resource)).rejects.toThrow(re);
  });
});

describe("createOverflowFacilitatorAdapter: prepare", () => {
  it("signs once with the paying node's key, from = treasury, to = escrow, validBefore clamped to the quote timeout", async () => {
    const o = order({ payingNodeId: 2 });
    const { adapter, seller, log } = harness(honest(o));
    const quote = await quoted(adapter, o);
    const prepared = await adapter.preparePayment(o.id, quote);
    expect(prepared.authorizationDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prepared.reservationTxHash).toBeUndefined();
    // Nothing left the process at prepare time; the only request so far is the quote.
    expect(seller.calls).toHaveLength(1);
    expect(log.some((l) => l.includes("node 2 is agent-research"))).toBe(true);

    // The header the submit will carry is a PaymentPayload whose authorization recovers to the research key.
    const submission = await adapter.submitPayment(o.id, prepared);
    expect(submission).toEqual({ outcome: "submitted", txHash: TX });
    const paidCall = seller.calls[1]!;
    const payload = parsePaymentPayload(paidCall.paid!);
    const a = payload.payload.authorization;
    expect(a.from).toBe(TREASURY);
    expect(a.to).toBe(ESCROW);
    expect(a.value).toBe("12000000");
    // order expires in 600 s; QUOTE_TIMEOUT_SECONDS = 120 wins.
    expect(a.validBefore).toBe(String(NOW_SEC + 120));
    expect(await recoverAuthorizationSigner({ ...a }, payload.payload.signature)).toBe(keys.children.research.address);
  });
  it("uses the order's authorizationExpiresAt when it is sooner than the quote timeout", async () => {
    const o = order({ authorizationExpiresAt: new Date(new Date(NOW).getTime() + 45_000).toISOString() });
    const { adapter, seller } = harness(honest(o));
    const prepared = await adapter.preparePayment(o.id, await quoted(adapter, o));
    await adapter.submitPayment(o.id, prepared);
    expect(parsePaymentPayload(seller.calls[1]!.paid!).payload.authorization.validBefore).toBe(String(NOW_SEC + 45));
  });
  it("refuses to sign once the authorization window has closed", async () => {
    const o = order({ authorizationExpiresAt: NOW });
    const { adapter, seller } = harness(honest(o));
    await expect(adapter.preparePayment(o.id, await quoted(adapter, o))).rejects.toBeInstanceOf(AuthorizationWindowClosedError);
    expect(seller.calls).toHaveLength(1);
  });
  it("throws NoSignerForNodeError when no key owns the paying node on chain, and never signs with another key", async () => {
    const o = order({ payingNodeId: 4 });
    const { adapter, seller } = harness(honest(o));
    const err = await adapter.preparePayment(o.id, await quoted(adapter, o)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoSignerForNodeError);
    expect((err as NoSignerForNodeError).nodeId).toBe(4);
    expect(seller.calls).toHaveLength(1);
    // Not in flight either: nothing was stored, so a later prepare (once the node exists) is not blocked.
    await expect(adapter.reconcilePayment(o.id)).resolves.toEqual({ status: "unknown" });
  });
  it("throws NoSignerForNodeError when nodeOfKey disagrees with the key the order would imply", async () => {
    // The chain says research owns node 7, not node 2: node 2 has no key here.
    const o = order({ payingNodeId: 2 });
    const { adapter } = harness(honest(o), { nodeOf: { [keys.children.research.address.toLowerCase()]: 7n } });
    await expect(adapter.preparePayment(o.id, await quoted(adapter, o))).rejects.toBeInstanceOf(NoSignerForNodeError);
  });
  it("a second prepare for the same purchase throws AuthorizationInFlightError with the first digest", async () => {
    const o = order();
    const { adapter } = harness(honest(o));
    const quote = await quoted(adapter, o);
    const first = await adapter.preparePayment(o.id, quote);
    const err = await adapter.preparePayment(o.id, quote).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthorizationInFlightError);
    expect((err as AuthorizationInFlightError).authorizationDigest).toBe(first.authorizationDigest);
  });
  it("refuses a quote whose order is another purchase or another treasury", async () => {
    const o = order();
    const { adapter } = harness(honest(o));
    const quote = await quoted(adapter, o);
    await expect(adapter.preparePayment("purchase-other", quote)).rejects.toBeInstanceOf(SellerQuoteError);
    const foreign = order({ buyerTreasury: SELLER });
    const { adapter: adapter2 } = harness(honest(foreign));
    await expect(adapter2.preparePayment(foreign.id, await quoted(adapter2, foreign))).rejects.toThrow(/treasury differs/);
  });
});

describe("createOverflowFacilitatorAdapter: submit mapping (as orchestration/tools.ts callPaidApi)", () => {
  async function prepared(script: Script, over: Parameters<typeof harness>[1] = {}) {
    const o = order();
    const h = harness((u, i, paid) => (paid ? script(u, i, paid) : r402(o)), over);
    const p = await h.adapter.preparePayment(o.id, await quoted(h.adapter, o));
    return { ...h, o, p };
  }
  it("200 + PAYMENT-RESPONSE.transaction -> submitted with that tx hash", async () => {
    const { adapter, o, p, seller } = await prepared(() => r200(TX));
    expect(await adapter.submitPayment(o.id, p)).toEqual({ outcome: "submitted", txHash: TX });
    expect(seller.calls.filter((c) => c.paid)).toHaveLength(1);
  });
  it("200 without a PAYMENT-RESPONSE is not a success: unknown", async () => {
    const { adapter, o, p } = await prepared(() => json(200, { looks: "fine" }));
    expect(await adapter.submitPayment(o.id, p)).toMatchObject({ outcome: "unknown", error: expect.stringMatching(/PAYMENT-RESPONSE/) });
  });
  it("402 payment_blocked -> rejected with Name(args)", async () => {
    const { adapter, o, p } = await prepared(() => rBlocked("PayeeNotAllowed", [ESCROW]));
    expect(await adapter.submitPayment(o.id, p)).toEqual({ outcome: "rejected", decodedRevert: `PayeeNotAllowed(${ESCROW})` });
  });
  it("402 payment_blocked with an onchain revert tx is still rejected (the hash is logged, not booked)", async () => {
    const { adapter, o, p, log } = await prepared(() => rBlocked("ExceedsCap", ["1", "2"], { txHash: TX }));
    expect(await adapter.submitPayment(o.id, p)).toEqual({ outcome: "rejected", decodedRevert: "ExceedsCap(1,2)" });
    expect(log.some((l) => l.includes(`reverted onchain ${TX}`))).toBe(true);
  });
  it("402 payment_blocked without decode details -> rejected 'payment_blocked'", async () => {
    const { adapter, o, p } = await prepared(() => json(402, { error: "payment_blocked" }));
    expect(await adapter.submitPayment(o.id, p)).toEqual({ outcome: "rejected", decodedRevert: "payment_blocked" });
  });
  it("502 payment_outcome_unknown -> unknown", async () => {
    const { adapter, o, p } = await prepared(() => rUnknown());
    expect(await adapter.submitPayment(o.id, p)).toMatchObject({ outcome: "unknown", error: expect.stringMatching(/payment_outcome_unknown/) });
  });
  it("network error on the paid request -> unknown (the authorization may have reached the chain)", async () => {
    const { adapter, o, p } = await prepared(() => Promise.reject(new TypeError("socket hang up")));
    expect(await adapter.submitPayment(o.id, p)).toMatchObject({ outcome: "unknown", error: expect.stringMatching(/socket hang up/) });
  });
  it("timeout -> unknown", async () => {
    const { adapter, o, p } = await prepared(() => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })));
    expect(await adapter.submitPayment(o.id, p)).toMatchObject({ outcome: "unknown", error: expect.stringMatching(/timeout/) });
  });
  it("a fresh 402 quote on the paid retry is unknown, not rejected, and nothing is re-signed", async () => {
    const o = order();
    const { adapter, seller } = harness(() => r402(o));
    const p = await adapter.preparePayment(o.id, await quoted(adapter, o));
    expect(await adapter.submitPayment(o.id, p)).toMatchObject({ outcome: "unknown" });
    expect(seller.calls.filter((c) => c.paid)).toHaveLength(1);
  });
});

describe("createOverflowFacilitatorAdapter: one signature, one send", () => {
  it("submitting twice throws AlreadySubmittedError whatever the first outcome was, and the seller saw exactly one paid request", async () => {
    for (const [label, script] of [
      ["submitted", () => r200(TX)],
      ["unknown", () => rUnknown()],
      ["network", () => Promise.reject(new TypeError("reset"))],
    ] as Array<[string, Script]>) {
      const o = order();
      const { adapter, seller } = harness((u, i, paid) => (paid ? script(u, i, paid) : r402(o)));
      const p = await adapter.preparePayment(o.id, await quoted(adapter, o));
      await adapter.submitPayment(o.id, p);
      await expect(adapter.submitPayment(o.id, p), label).rejects.toBeInstanceOf(AlreadySubmittedError);
      expect(seller.calls.filter((c) => c.paid), label).toHaveLength(1);
      // And still no second signature: prepare stays blocked by the first digest.
      await expect(adapter.preparePayment(o.id, await quoted(adapter, o)), label).rejects.toBeInstanceOf(AuthorizationInFlightError);
    }
  });
  it("concurrent submits: one goes out, the other throws AlreadySubmittedError", async () => {
    const o = order();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { adapter, seller } = harness(async (_u, _i, paid) => {
      if (!paid) return r402(o);
      await gate;
      return r200(TX);
    });
    const p = await adapter.preparePayment(o.id, await quoted(adapter, o));
    const first = adapter.submitPayment(o.id, p);
    const second = adapter.submitPayment(o.id, p).catch((e: unknown) => e);
    release();
    expect(await first).toEqual({ outcome: "submitted", txHash: TX });
    expect(await second).toBeInstanceOf(AlreadySubmittedError);
    expect(seller.calls.filter((c) => c.paid)).toHaveLength(1);
  });
  it("a PreparedPayment this process did not sign is refused (reconcile, never resend)", async () => {
    const o = order();
    const { adapter, seller } = harness(honest(o));
    await expect(adapter.submitPayment(o.id, { authorizationDigest: b32(42) })).rejects.toBeInstanceOf(UnknownPreparedPaymentError);
    expect(seller.calls).toHaveLength(0);
  });
});

describe("createOverflowFacilitatorAdapter: reconcile", () => {
  async function submitted(script: Script, over: Parameters<typeof harness>[1] = {}) {
    const o = order();
    const h = harness((u, i, paid) => (paid ? script(u, i, paid) : r402(o)), over);
    const p = await h.adapter.preparePayment(o.id, await quoted(h.adapter, o));
    const submission = await h.adapter.submitPayment(o.id, p);
    return { ...h, o, p, submission };
  }
  it("nonce consumed on chain + stored submission tx -> funded with that tx", async () => {
    const { adapter, o } = await submitted(() => r200(TX), { authorizationState: true });
    expect(await adapter.reconcilePayment(o.id)).toEqual({ status: "funded", txHash: TX });
  });
  it("nonce consumed after an unknown outcome -> funded with the Paid log's tx for that nonce", async () => {
    const seen: Hex[] = [];
    const { adapter, o } = await submitted(() => rUnknown(), {
      authorizationState: true,
      findPaidTx: async (nonce) => {
        seen.push(nonce);
        return b32(0xca11);
      },
    });
    expect(await adapter.reconcilePayment(o.id)).toEqual({ status: "funded", txHash: b32(0xca11) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("nonce consumed but no Paid log found -> unknown (never a fabricated tx)", async () => {
    const { adapter, o } = await submitted(() => rUnknown(), { authorizationState: true, findPaidTx: async () => null });
    expect(await adapter.reconcilePayment(o.id)).toEqual({ status: "unknown" });
  });
  it("nonce unconsumed and validBefore passed -> not-settled; before that -> unknown", async () => {
    const o = order();
    let clock = new Date(NOW);
    const seller = fakeSeller((u, i, paid) => (paid ? rUnknown() : r402(o)));
    const adapter = createOverflowFacilitatorAdapter({
      sellerUrl: SELLER_URL,
      fetch: seller.fetch,
      treasury: TREASURY,
      nodeSigners: createNodeSigners({ keys, chain: nodeOf() }),
      chain: { authorizationState: async () => false },
      now: () => clock,
    });
    const p = await adapter.preparePayment(o.id, await quoted(adapter, o));
    await adapter.submitPayment(o.id, p);
    expect(await adapter.reconcilePayment(o.id)).toEqual({ status: "unknown" });
    clock = new Date(new Date(NOW).getTime() + 120_000); // == validBefore: still live
    expect(await adapter.reconcilePayment(o.id)).toEqual({ status: "unknown" });
    clock = new Date(new Date(NOW).getTime() + 121_000); // past validBefore and unconsumed: it can never settle
    expect(await adapter.reconcilePayment(o.id)).toEqual({ status: "not-settled" });
  });
  it("a purchase this process never prepared -> unknown (no nonce to ask the chain about)", async () => {
    const { adapter } = harness(() => r402(order()));
    expect(await adapter.reconcilePayment("purchase-unknown")).toEqual({ status: "unknown" });
  });
  it("chain read failure -> unknown", async () => {
    const o = order();
    const seller = fakeSeller((u, i, paid) => (paid ? rUnknown() : r402(o)));
    const adapter = createOverflowFacilitatorAdapter({
      sellerUrl: SELLER_URL,
      fetch: seller.fetch,
      treasury: TREASURY,
      nodeSigners: createNodeSigners({ keys, chain: nodeOf() }),
      chain: {
        authorizationState: async () => {
          throw new Error("rpc down");
        },
      },
      now: () => new Date(NOW),
    });
    const p = await adapter.preparePayment(o.id, await quoted(adapter, o));
    await adapter.submitPayment(o.id, p);
    expect(await adapter.reconcilePayment(o.id)).toEqual({ status: "unknown" });
  });
});

describe("createNodeSigners", () => {
  it("maps node ids to keys only through treasury.nodeOfKey and caches confirmed ones", async () => {
    let reads = 0;
    const chain = { nodeOfKey: async (k: Address) => (reads++, (await nodeOf().nodeOfKey(k))) };
    const signers = createNodeSigners({ keys, chain });
    const s = await signers.signerFor(3);
    expect(s.agentId).toBe("agent-finance");
    expect(s.account.address).toBe(keys.children.finance.address);
    const before = reads;
    const again = await signers.signerFor(3);
    expect(again.account.address).toBe(s.account.address);
    expect(reads).toBe(before + 1); // one re-confirmation read, not a full scan
    expect(signers.candidates().map((c) => c.agentId)).toEqual(["agent-orchestrator", "agent-research", "agent-finance", "agent-verification"]);
  });
  it("drops a cached key once the chain stops confirming it", async () => {
    const table: Record<string, bigint> = { [keys.root.address.toLowerCase()]: 1n };
    const signers = createNodeSigners({ keys, chain: { nodeOfKey: async (k) => table[k.toLowerCase()] ?? 0n } });
    expect((await signers.signerFor(1)).agentId).toBe("agent-orchestrator");
    delete table[keys.root.address.toLowerCase()];
    await expect(signers.signerFor(1)).rejects.toBeInstanceOf(NoSignerForNodeError);
  });
  it("rejects non-positive node ids without touching the chain", async () => {
    const signers = createNodeSigners({ keys, chain: { nodeOfKey: async () => 1n } });
    await expect(signers.signerFor(0)).rejects.toBeInstanceOf(NoSignerForNodeError);
  });
});
