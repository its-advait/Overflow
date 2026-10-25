import { decodeBase64Json, X402_HEADERS, type PaymentRequired } from "@overflow/payment-client";
import { hashLeaf, buildTree, splitDataset, chunkKey } from "@overflow/recourse-crypto";
import type { Address, Hex } from "@overflow/schemas";
import { beforeAll, describe, expect, it } from "vitest";
import type { Facilitator, SettleInput, SettleOutcome } from "../../facilitator/settle.js";
import { createBehaviorStore } from "./behavior.js";
import { createFakeRecourseChain } from "./chain.test-util.js";
import type { RecourseListing } from "./datasets.js";
import { BUYER, loadSmallListing, SALT, SELLER, SELLER_SECRET, SMALL_LISTING_ID } from "./fixtures.test-util.js";
import { createOrderStore } from "./orders.js";
import { CreateOrderResponseSchema, SampleResponseSchema } from "./protocol.js";
import { createRecourseRoutes } from "./routes.js";

const SELLER_URL = "http://localhost:4100";
const TX = `0x${"77".repeat(32)}` as Hex;
const NOW = 1_800_000_000n;
let listing: RecourseListing;
beforeAll(async () => {
  listing = await loadSmallListing();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json() as Promise<any>;
const paid = (): SettleOutcome => ({ outcome: "paid", txHash: TX, blockNumber: "42", nodeId: "3", payer: BUYER, digest: `0x${"d1".repeat(32)}` as Hex });
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

function harness(over: { facilitator?: Facilitator | null; isEscrow?: boolean } = {}) {
  const chain = createFakeRecourseChain({ sellerAddress: SELLER.address, now: () => NOW });
  if (over.isEscrow !== undefined) chain.isEscrowOverride = over.isEscrow;
  const behaviors = createBehaviorStore(new Map([["sim-seller-a", "honest"]]));
  const store = createOrderStore();
  let n = 0;
  const app = createRecourseRoutes({
    listings: new Map([[listing.id, listing]]),
    sellers: new Map([["sim-seller-a", { sellerId: "sim-seller-a", address: SELLER.address, sellerSecret: SELLER_SECRET, chain }]]),
    behaviors,
    store,
    sellerUrl: SELLER_URL,
    facilitator: over.facilitator ?? null,
    allowForceBroadcast: false,
    config: { bondBps: 2000, revealWindowS: 600, challengeWindowS: 120 },
    now: () => NOW,
    log: () => {},
    randomSalt: () => (n++ === 0 ? SALT : (`0x${(n + 1).toString(16).padStart(64, "0")}` as Hex)),
  });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const createOrder = () => post("/orders", { resourceId: SMALL_LISTING_ID, buyerTreasury: BUYER, missionId: "m-1" });
  return { app, chain, behaviors, store, post, createOrder };
}

describe("SIMULATED Recourse seller routes", () => {
  it("POST /orders creates an escrow-backed order (201), replays it (200), 404s unknown resources", async () => {
    const h = harness();
    const res = await h.createOrder();
    expect(res.status).toBe(201);
    const body = CreateOrderResponseSchema.parse(await json(res));
    expect(body.simulated).toBe(true);
    expect(body.replayed).toBe(false);
    expect(body.salt).toBe(SALT);
    expect(body.escrowAddress).toBe(await h.chain.predict(body.orderId, body.terms.termsHash));
    expect(await h.chain.isEscrow(body.escrowAddress)).toBe(true);
    expect(body.resourceUrl).toBe(`${SELLER_URL}/r/${SMALL_LISTING_ID}?order=${body.orderId}`);
    expect(body.cipherUrl).toBe(`${SELLER_URL}/orders/${body.orderId}/cipher`);

    const again = await h.createOrder();
    expect(again.status).toBe(200);
    const replay = await json(again);
    expect(replay.replayed).toBe(true);
    expect(replay.orderId).toBe(body.orderId);
    expect(h.chain.calls.filter((c) => c.fn === "create")).toHaveLength(1);

    const missing = await h.post("/orders", { resourceId: "nope", buyerTreasury: BUYER, missionId: "m-1" });
    expect(missing.status).toBe(404);
    expect((await json(missing)).simulated).toBe(true);

    const view = await json(await h.app.request(`/orders/${body.orderId}`));
    expect(view.simulated).toBe(true);
    expect(view.k).toBeUndefined();
    expect(view.cipherChunks).toBeUndefined();
  });

  it("POST /orders clamps per-order windows and 409s a flagged seller", async () => {
    const h = harness();
    const res = await h.post("/orders", { resourceId: SMALL_LISTING_ID, buyerTreasury: BUYER, missionId: "m-2", revealWindowS: 5, challengeWindowS: 99_999 });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.terms.revealDeadline).toBe((NOW + 60n).toString());
    expect(body.terms.challengeWindow).toBe("3600");

    h.chain.flagSeller(SELLER.address);
    const flagged = await h.post("/orders", { resourceId: SMALL_LISTING_ID, buyerTreasury: BUYER, missionId: "m-3" });
    expect(flagged.status).toBe(409);
    expect(await json(flagged)).toMatchObject({ error: "seller_flagged", simulated: true });
  });

  it("GET /orders/:id/cipher serves chunkCount*160 bytes that verify to rootCipher, and a json form", async () => {
    const h = harness();
    const order = await json(await h.createOrder());
    const res = await h.app.request(`/orders/${order.orderId}/cipher`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-overflow-simulated")).toBe("true");
    expect(res.headers.get("x-overflow-chunk-count")).toBe("48");
    expect(res.headers.get("x-overflow-root-cipher")).toBe(order.terms.rootCipher);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(48 * 160);
    expect(buildTree(splitDataset(bytes).map(hashLeaf)).root).toBe(order.terms.rootCipher);
    const j = await json(await h.app.request(`/orders/${order.orderId}/cipher?format=json`));
    expect(j).toMatchObject({ simulated: true, orderId: order.orderId, chunkCount: 48, rootCipher: order.terms.rootCipher });
    expect(j.chunks).toHaveLength(48);
  });

  it("GET /r/:id/manifest serves the dataset manifest; 404 unknown", async () => {
    const h = harness();
    const m = await json(await h.app.request(`/r/${SMALL_LISTING_ID}/manifest`));
    expect(m).toMatchObject({ simulated: true, rootPlain: listing.manifest.rootPlain, chunkCount: 48 });
    expect(m.plainLeaves).toHaveLength(48);
    expect((await h.app.request(`/r/nope/manifest`)).status).toBe(404);
  });

  it("POST /orders/:id/sample reveals only the requested chunk keys; 400 out of range; 409 before the escrow exists", async () => {
    const h = harness();
    const order = await json(await h.createOrder());
    const res = await h.post(`/orders/${order.orderId}/sample`, { indices: [3, 7, 3] });
    expect(res.status).toBe(200);
    const body = SampleResponseSchema.parse(await json(res));
    expect(body.reveals.map((r) => r.index)).toEqual([3, 7]);
    const k = h.store.get(order.orderId)!.k;
    expect(body.reveals[0]!.chunkKey).toBe(chunkKey(k, 3));

    expect((await h.post(`/orders/${order.orderId}/sample`, { indices: [48] })).status).toBe(400);
    expect((await h.post(`/orders/${order.orderId}/sample`, { indices: Array.from({ length: 65 }, (_, i) => i) })).status).toBe(400);

    h.chain.isEscrowOverride = false;
    const early = await h.post(`/orders/${order.orderId}/sample`, { indices: [1] });
    expect(early.status).toBe(409);
    expect(await json(early)).toMatchObject({ error: "order_not_onchain", simulated: true });
  });

  it("behavior GET/PUT with validation", async () => {
    const h = harness();
    expect(await json(await h.app.request("/sellers/sim-seller-a/behavior"))).toMatchObject({ simulated: true, behavior: "honest", sellerAddress: SELLER.address });
    const put = await h.app.request("/sellers/sim-seller-a/behavior", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ behavior: "ghost" }) });
    expect(put.status).toBe(200);
    expect((await json(put)).behavior).toBe("ghost");
    expect(h.behaviors.get("sim-seller-a")).toBe("ghost");
    const bad = await h.app.request("/sellers/sim-seller-a/behavior", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ behavior: "evil" }) });
    expect(bad.status).toBe(400);
    expect((await h.app.request("/sellers/nope/behavior")).status).toBe(404);
    const list = await json(await h.app.request("/sellers"));
    expect(list.sellers[0]).toMatchObject({ sellerId: "sim-seller-a", behavior: "ghost", listings: [SMALL_LISTING_ID] });
  });

  it("GET /r/:id?order= paywalls with payTo = escrow and the listing price; paid retry returns delivery with settlement", async () => {
    const f = fakeFacilitator(paid);
    const h = harness({ facilitator: f.facilitator });
    const order = await json(await h.createOrder());
    const path = `/r/${SMALL_LISTING_ID}?order=${order.orderId}`;
    const res = await h.app.request(path);
    expect(res.status).toBe(402);
    const required = decodeBase64Json(res.headers.get(X402_HEADERS.paymentRequired)!) as PaymentRequired;
    expect(required.accepts[0]!.payTo).toBe(order.escrowAddress);
    expect(required.accepts[0]!.amount).toBe(listing.priceAtomic);
    expect(required.resource.url).toBe(`${SELLER_URL}${path}`);
    expect((await json(res)).simulated).toBe(true);

    expect((await h.app.request(`/r/${SMALL_LISTING_ID}`)).status).toBe(400);
    expect((await h.app.request(`/r/${SMALL_LISTING_ID}?order=0x${"ab".repeat(32)}`)).status).toBe(404);
    expect((await h.app.request(`/r/nope?order=${order.orderId}`)).status).toBe(404);

    const payload = {
      x402Version: 2,
      scheme: "exact",
      network: required.accepts[0]!.network,
      accepted: required.accepts[0],
      payload: {
        signature: `0x${"11".repeat(65)}`,
        authorization: { from: BUYER, to: order.escrowAddress, value: listing.priceAtomic, validAfter: "0", validBefore: String(NOW + 100n), nonce: `0x${"22".repeat(32)}` },
      },
    };
    const header = Buffer.from(JSON.stringify(payload)).toString("base64");
    const paidRes = await h.app.request(path, { headers: { [X402_HEADERS.paymentSignature]: header } });
    expect(paidRes.status).toBe(200);
    const body = await json(paidRes);
    expect(body).toMatchObject({ simulated: true, orderId: order.orderId, escrowAddress: order.escrowAddress, chunkCount: 48, settlement: { txHash: TX, blockNumber: "42" } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.requirements.payTo).toBe(order.escrowAddress as Address);
  });
});
