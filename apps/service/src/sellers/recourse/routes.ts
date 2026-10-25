import { joinChunks, revealChunkKeys } from "@overflow/recourse-crypto";
import { type Address, type AtomicAmount, type Hex } from "@overflow/schemas";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getAddress, keccak256, toHex } from "viem";
import { randomBytes } from "node:crypto";
import { toApiError } from "../../api/http.js";
import type { Facilitator } from "../../facilitator/settle.js";
import { paywall, type SellerEnv } from "../paywall.js";
import type { BehaviorStore } from "./behavior.js";
import type { RecourseChain } from "./chain.js";
import type { RecourseListing } from "./datasets.js";
import { publicView, type OrderRecord, type OrderStore } from "./orders.js";
import {
  BehaviorResponseSchema,
  CHALLENGE_WINDOW_BOUNDS_S,
  CreateOrderBodySchema,
  CreateOrderResponseSchema,
  MAX_SAMPLE,
  PutBehaviorBodySchema,
  REVEAL_WINDOW_BOUNDS_S,
  SampleBodySchema,
  SampleResponseSchema,
  SellerBehaviorSchema,
  type CreateOrderResponse,
} from "./protocol.js";
import { buildOrder, type BuildOrderConfig } from "./terms.js";

// ---------------------------------------------------------------------------
// HTTP surface of the SIMULATED Recourse sellers. Agents propose; only the
// factory/escrow contracts move money: POST /orders asks the seller to call
// factory.create (a commitment, not a payment), /r/:id is the x402 paywall whose
// payee is the per-order escrow, and the worker (worker.ts) drives bond, reveal
// and payout. Every JSON body carries `simulated: true`.
// ---------------------------------------------------------------------------

export const LOG_PREFIX = "[sellers:recourse:SIMULATED]";

export interface RecourseSellerRuntime {
  sellerId: string;
  address: Address;
  sellerSecret: Hex;
  chain: RecourseChain;
}

export interface CreateRecourseRoutesOptions {
  listings: Map<string, RecourseListing>;
  sellers: Map<string, RecourseSellerRuntime>;
  behaviors: BehaviorStore;
  store: OrderStore;
  sellerUrl: string;
  facilitator: Facilitator | null;
  facilitatorUnavailableReason?: string | undefined;
  allowForceBroadcast: boolean;
  /** Default windows/bond; POST /orders may override the windows within protocol bounds. */
  config: BuildOrderConfig;
  /** Unix seconds; defaults to the wall clock. */
  now?: (() => bigint) | undefined;
  log?: ((line: string) => void) | undefined;
  randomSalt?: (() => Hex) | undefined;
}

const clamp = (v: number | undefined, fallback: number, b: { min: number; max: number }) => Math.min(b.max, Math.max(b.min, v ?? fallback));

export function createRecourseRoutes(opts: CreateRecourseRoutesOptions): Hono<SellerEnv> {
  const { listings, sellers, behaviors, store, sellerUrl } = opts;
  const now = opts.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const log = opts.log ?? ((line: string) => console.log(`${LOG_PREFIX} ${line}`));
  const randomSalt = opts.randomSalt ?? (() => toHex(randomBytes(32)));
  const inflight = new Map<string, Promise<OrderRecord | Response>>();

  const app = new Hono<SellerEnv>();
  app.onError((e, c) => {
    const err = toApiError(e);
    if (err.status === 500) console.error(`${LOG_PREFIX} ${c.req.method} ${c.req.path}`, e);
    return c.json({ error: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}), simulated: true }, err.status);
  });

  const fail = (c: Context, status: ContentfulStatusCode, error: string, message: string, extra: Record<string, unknown> = {}) =>
    c.json({ error, message, ...extra, simulated: true }, status);

  const listingsOf = (sellerId: string) => [...listings.values()].filter((l) => l.sellerId === sellerId).map((l) => l.id);
  const behaviorBody = (s: RecourseSellerRuntime) =>
    BehaviorResponseSchema.parse({ simulated: true, sellerId: s.sellerId, sellerAddress: s.address, behavior: behaviors.get(s.sellerId) ?? "honest", options: SellerBehaviorSchema.options });

  const toCreateResponse = (o: OrderRecord, replayed: boolean): CreateOrderResponse =>
    CreateOrderResponseSchema.parse({
      simulated: true,
      orderId: o.orderId,
      escrowAddress: o.escrowAddress,
      sellerId: o.sellerId,
      resourceId: o.listingId,
      missionId: o.missionId,
      salt: o.salt,
      terms: o.terms,
      createTxHash: o.createTxHash,
      replayed,
      cipherUrl: `${sellerUrl}/orders/${o.orderId}/cipher`,
      sampleUrl: `${sellerUrl}/orders/${o.orderId}/sample`,
      resourceUrl: `${sellerUrl}/r/${o.listingId}?order=${o.orderId}`,
    });

  app.get("/sellers", (c) =>
    c.json({
      simulated: true,
      sellers: [...sellers.values()].map((s) => ({ sellerId: s.sellerId, sellerAddress: s.address, behavior: behaviors.get(s.sellerId) ?? "honest", listings: listingsOf(s.sellerId) })),
    }),
  );

  app.get("/sellers/:id/behavior", (c) => {
    const s = sellers.get(c.req.param("id"));
    if (!s) return fail(c, 404, "unknown_seller", `${c.req.param("id")} is not a SIMULATED Recourse seller`);
    return c.json(behaviorBody(s));
  });

  app.put("/sellers/:id/behavior", async (c) => {
    const s = sellers.get(c.req.param("id"));
    if (!s) return fail(c, 404, "unknown_seller", `${c.req.param("id")} is not a SIMULATED Recourse seller`);
    const body = PutBehaviorBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, 400, "invalid_behavior", `behavior must be one of ${SellerBehaviorSchema.options.join("|")}`, { details: body.error.issues });
    const change = behaviors.set(s.sellerId, body.data.behavior);
    log(`behavior ${s.sellerId}: ${change.from} -> ${change.to}`);
    return c.json(behaviorBody(s));
  });

  // Free: the dataset manifest (plainLeaves let the buyer verify samples and build mismatch complaints).
  app.get("/r/:resourceId/manifest", (c) => {
    const listing = listings.get(c.req.param("resourceId"));
    if (!listing) return fail(c, 404, "unknown_resource", `${c.req.param("resourceId")} is not a SIMULATED Recourse listing`);
    return c.json(listing.manifest);
  });

  app.post("/orders", async (c) => {
    const body = CreateOrderBodySchema.parse(await c.req.json());
    const listing = listings.get(body.resourceId);
    if (!listing) return fail(c, 404, "unknown_resource", `${body.resourceId} is not a SIMULATED Recourse listing`);
    const seller = sellers.get(listing.sellerId);
    if (!seller) return fail(c, 503, "seller_not_configured", `no key configured for ${listing.sellerId} (SELLER_KEYS)`);
    const buyer = getAddress(body.buyerTreasury);

    const existing = store.findOpen(body.missionId, listing.id, buyer);
    if (existing) return c.json(toCreateResponse(existing, true), 200);

    const key = `${body.missionId}|${listing.id}|${buyer.toLowerCase()}`;
    const pending = inflight.get(key);
    if (pending) {
      const r = await pending;
      return r instanceof Response ? r.clone() : c.json(toCreateResponse(r, true), 200);
    }

    const work = (async (): Promise<OrderRecord | Response> => {
      const cheats = await seller.chain.provenCheats(seller.address);
      if (cheats !== 0n) {
        return fail(c, 409, "seller_flagged", `${seller.sellerId} has ${cheats} proven cheat(s) on chain; the factory refuses new orders`, { provenCheats: cheats.toString(10) });
      }
      const behavior = behaviors.get(seller.sellerId) ?? "honest";
      const salt = randomSalt();
      const built = buildOrder({
        listing,
        buyer,
        missionId: body.missionId,
        seller: seller.address,
        sellerSecret: seller.sellerSecret,
        salt,
        nowSeconds: now(),
        config: {
          ...opts.config,
          revealWindowS: clamp(body.revealWindowS, opts.config.revealWindowS, REVEAL_WINDOW_BOUNDS_S),
          challengeWindowS: clamp(body.challengeWindowS, opts.config.challengeWindowS, CHALLENGE_WINDOW_BOUNDS_S),
        },
        behavior,
      });
      const { terms } = built;
      const escrow = await seller.chain.predict(terms.orderId, terms.termsHash);
      log(`create ${terms.orderId.slice(0, 10)} ${listing.id} buyer ${buyer} behavior ${behavior}${built.swapIndex !== null ? ` swapIndex ${built.swapIndex}` : ""} -> escrow ${escrow}`);
      const outcome = await seller.chain.create(terms);
      if (outcome.status === "simulation-reverted") {
        log(`create ${terms.orderId.slice(0, 10)} simulation reverted: ${outcome.error}`);
        return fail(c, 502, "escrow_create_rejected", `factory.create simulation reverted: ${outcome.error}`, { orderId: terms.orderId });
      }
      if (outcome.status === "reverted") {
        log(`create ${terms.orderId.slice(0, 10)} reverted in ${outcome.hash}`);
        return fail(c, 502, "escrow_create_reverted", `factory.create reverted on chain`, { orderId: terms.orderId, txHash: outcome.hash });
      }
      if (outcome.status === "unknown") {
        // Not stored as created: the next POST derives a fresh salt, and this tx is reconciled by hand against the hash.
        log(`create ${terms.orderId.slice(0, 10)} outcome UNKNOWN tx ${outcome.hash}: ${outcome.error}; not stored, not retried automatically`);
        return fail(c, 502, "escrow_create_unknown", `factory.create outcome unknown (${outcome.error}); reconcile tx ${outcome.hash} against the chain before any retry`, {
          orderId: terms.orderId,
          txHash: outcome.hash,
        });
      }
      if (!(await seller.chain.isEscrow(escrow))) {
        return fail(c, 502, "escrow_not_found", `factory.create succeeded in ${outcome.hash} but ${escrow} is not a registered escrow`, { orderId: terms.orderId, txHash: outcome.hash });
      }
      const order: OrderRecord = {
        orderId: terms.orderId,
        listingId: listing.id,
        sellerId: seller.sellerId,
        sellerAddress: seller.address,
        buyer,
        missionId: body.missionId,
        salt,
        terms,
        escrowAddress: escrow,
        createTxHash: outcome.hash,
        k: built.k,
        cipherChunks: built.cipherChunks,
        plainLeaves: listing.plainLeaves,
        swapIndex: built.swapIndex,
        behaviorAtCreate: behavior,
        createdAt: new Date().toISOString(),
        actions: [],
        lastStatus: "Created",
        bondSent: false,
        notes: [],
        closed: false,
      };
      store.insert(order);
      log(`created ${terms.orderId.slice(0, 10)} escrow ${escrow} tx ${outcome.hash}`);
      return order;
    })();
    inflight.set(key, work);
    try {
      const r = await work;
      return r instanceof Response ? r : c.json(toCreateResponse(r, false), 201);
    } finally {
      inflight.delete(key);
    }
  });

  app.get("/orders/:id", (c) => {
    const o = store.get(c.req.param("id"));
    if (!o) return fail(c, 404, "unknown_order", `${c.req.param("id")} is not a SIMULATED Recourse order`);
    return c.json(publicView(o));
  });

  app.get("/orders/:id/cipher", (c) => {
    const o = store.get(c.req.param("id"));
    if (!o) return fail(c, 404, "unknown_order", `${c.req.param("id")} is not a SIMULATED Recourse order`);
    if (c.req.query("format") === "json") {
      return c.json({ simulated: true, orderId: o.orderId, chunkCount: o.terms.chunkCount, rootCipher: o.terms.rootCipher, chunks: o.cipherChunks.map((ch) => toHex(ch)) });
    }
    const bytes = joinChunks(o.cipherChunks);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return c.body(buffer, 200, {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "x-overflow-chunk-count": String(o.terms.chunkCount),
      "x-overflow-root-cipher": o.terms.rootCipher,
      "x-overflow-order-id": o.orderId,
      "x-overflow-simulated": "true",
    });
  });

  app.post("/orders/:id/sample", async (c) => {
    const o = store.get(c.req.param("id"));
    if (!o) return fail(c, 404, "unknown_order", `${c.req.param("id")} is not a SIMULATED Recourse order`);
    const body = SampleBodySchema.parse(await c.req.json());
    const indices = [...new Set(body.indices)];
    if (indices.length > MAX_SAMPLE) return fail(c, 400, "too_many_indices", `at most ${MAX_SAMPLE} indices per sample`);
    const bad = indices.filter((i) => i >= o.terms.chunkCount);
    if (bad.length > 0) return fail(c, 400, "index_out_of_range", `indices ${bad.join(",")} are >= chunkCount ${o.terms.chunkCount}`);
    const seller = sellers.get(o.sellerId);
    if (!seller) return fail(c, 503, "seller_not_configured", `no key configured for ${o.sellerId}`);
    if (!(await seller.chain.isEscrow(o.escrowAddress))) {
      return fail(c, 409, "order_not_onchain", `escrow ${o.escrowAddress} is not registered by the factory yet; sample keys are revealed only against an on-chain commitment`);
    }
    return c.json(SampleResponseSchema.parse({ simulated: true, orderId: o.orderId, reveals: revealChunkKeys(o.k, indices) }));
  });

  // The x402 paywall for the dataset: payTo is the per-order escrow, price the listing's amount.
  const orderFor = (c: { req: { query(name: string): string | undefined } }): OrderRecord | undefined => {
    const id = c.req.query("order");
    return id ? store.get(id) : undefined;
  };
  app.get(
    "/r/:resourceId",
    async (c, next) => {
      const resourceId = c.req.param("resourceId");
      if (!listings.has(resourceId)) return fail(c, 404, "unknown_resource", `${resourceId} is not a SIMULATED Recourse listing`);
      const id = c.req.query("order");
      if (!id) return fail(c, 400, "missing_order", "query parameter `order` (orderId from POST /orders) is required");
      const o = store.get(id);
      if (!o || o.listingId !== resourceId) return fail(c, 404, "unknown_order", `${id} is not an open SIMULATED Recourse order for ${resourceId}`);
      await next();
    },
    paywall({
      sellerUrl,
      facilitator: opts.facilitator,
      facilitatorUnavailableReason: opts.facilitatorUnavailableReason,
      allowForceBroadcast: opts.allowForceBroadcast,
      keepQuery: true,
      payTo: (c) => orderFor(c)?.escrowAddress ?? null,
      amountAtomic: (c) => orderFor(c)!.terms.amount as AtomicAmount,
      description: "Dataset delivery (SIMULATED Recourse seller; pays the per-order escrow)",
    }),
    (c) => {
      const o = orderFor(c)!;
      const s = c.get("settlement");
      log(`paid ${o.orderId.slice(0, 10)} escrow ${o.escrowAddress} tx ${s?.txHash ?? "?"}`);
      return c.json({
        simulated: true,
        orderId: o.orderId,
        escrowAddress: o.escrowAddress,
        sellerId: o.sellerId,
        resourceId: o.listingId,
        cipherUrl: `${sellerUrl}/orders/${o.orderId}/cipher`,
        sampleUrl: `${sellerUrl}/orders/${o.orderId}/sample`,
        manifestUrl: `${sellerUrl}/r/${o.listingId}/manifest`,
        chunkCount: o.terms.chunkCount,
        rootPlain: o.terms.rootPlain,
        rootCipher: o.terms.rootCipher,
        keyCommitment: o.terms.keyCommitment,
        revealDeadline: o.terms.revealDeadline,
        challengeWindow: o.terms.challengeWindow,
        instructions:
          "Payment went to the per-order escrow, not the seller. Once the escrow is funded the seller reveals the key on chain (KeyRevealed); decrypt the ciphertext with it; complain on chain within the challenge window if a chunk mismatches the manifest's plainLeaves; if no key is revealed by revealDeadline, claimTimeoutRefund.",
        settlement: s ? { txHash: s.txHash, blockNumber: s.blockNumber, nodeId: s.nodeId, payer: s.payer } : null,
      });
    },
  );

  return app;
}

/** Deterministic salt for tests/demos; production uses crypto randomness. */
export function saltFromSeed(seed: string): Hex {
  return keccak256(toHex(seed));
}
