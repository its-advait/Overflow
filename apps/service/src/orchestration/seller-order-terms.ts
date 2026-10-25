import { computeOrderId, computeTermsHash, USDC, type Address, type Hex } from "@overflow/schemas";
import { QUOTE_TIMEOUT_SECONDS } from "../sellers/prices.js";
import type { RecourseChainReads } from "../sellers/recourse/chain.js";
import { CreateOrderResponseSchema, type CreateOrderBody, type CreateOrderResponse } from "../sellers/recourse/protocol.js";
import type { OrderTerms, OrderTermsInput, OrderTermsPort } from "./oracle-port.js";

// ---------------------------------------------------------------------------
// OrderTermsPort backed by a Recourse seller (SIMULATED in this repo): docs/SPEC.md
// "One purchase, end to end", step 3. POST /orders asks the seller to commit
// delivery terms and create the escrow; this module then recomputes termsHash
// and orderId from the fixed ABI fields (never JSON), checks that the terms name
// our treasury, USDC, the listed price and the listed manifest, and asks the
// factory that the escrow exists at predict(orderId, termsHash). Any mismatch
// is a SellerTermsError and no purchase is written: nothing here fabricates a
// seller, an escrow or a hash. It never signs and never moves USDC.
// ---------------------------------------------------------------------------

export class SellerTermsError extends Error {
  constructor(
    public readonly reason: string,
    public readonly details?: unknown,
  ) {
    super(`seller order terms rejected: ${reason}`);
    this.name = "SellerTermsError";
  }
}

export interface SellerOrderTermsOptions {
  /** Base URL of the seller app, e.g. SELLER_URL. */
  sellerUrl: string;
  /** How to reach the seller; index.ts passes the seller Hono app's `app.request` so no socket is needed in-process. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Factory reads: the escrow must exist and be the prediction for (orderId, termsHash). */
  reads: Pick<RecourseChainReads, "isEscrow" | "predict">;
  /** The deployed treasury: the only buyer these terms may name. */
  treasury: Address;
  now?: (() => Date) | undefined;
  log?: ((line: string) => void) | undefined;
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 500);
  }
}

export function createSellerOrderTerms(opts: SellerOrderTermsOptions): OrderTermsPort {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const sellerUrl = opts.sellerUrl.replace(/\/$/, "");

  async function postOrder(body: CreateOrderBody): Promise<CreateOrderResponse> {
    let res: Response;
    try {
      res = await opts.fetch(`${sellerUrl}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new SellerTermsError("seller unreachable", { error: e instanceof Error ? e.message : String(e) });
    }
    const raw = await readBody(res);
    if (res.status < 200 || res.status >= 300) throw new SellerTermsError(`seller answered ${res.status}`, { status: res.status, body: raw });
    const parsed = CreateOrderResponseSchema.safeParse(raw);
    if (!parsed.success) throw new SellerTermsError("seller response failed its schema", { issues: parsed.error.issues });
    return parsed.data;
  }

  return {
    async prepare(input: OrderTermsInput): Promise<OrderTerms> {
      const treasury = opts.treasury;
      if (!sameAddress(input.buyerTreasury, treasury)) {
        throw new SellerTermsError("buyer treasury differs from the deployed treasury", { input: input.buyerTreasury, treasury });
      }
      const order = await postOrder({ resourceId: input.resource.id, buyerTreasury: treasury, missionId: input.mission.id });
      const t = order.terms;
      const fail = (reason: string, details?: unknown): never => {
        throw new SellerTermsError(reason, { orderId: order.orderId, sellerId: order.sellerId, ...(details !== undefined ? { details } : {}) });
      };

      // Echo fields: the seller must have answered this mission and resource.
      if (order.resourceId !== input.resource.id) fail("resourceId mismatch", { expected: input.resource.id, actual: order.resourceId });
      if (order.missionId !== input.mission.id) fail("missionId mismatch", { expected: input.mission.id, actual: order.missionId });

      // Who pays whom, how much, for what.
      if (!sameAddress(t.buyer, treasury)) fail("terms.buyer is not the treasury", { expected: treasury, actual: t.buyer });
      if (!sameAddress(t.token, USDC.address)) fail("terms.token is not USDC", { expected: USDC.address, actual: t.token });
      if (BigInt(t.amount) !== BigInt(input.amountAtomic)) fail("terms.amount differs from the listed price", { expected: input.amountAtomic, actual: t.amount });
      if (t.manifestHash !== input.resource.manifestHash) fail("terms.manifestHash differs from the listing", { expected: input.resource.manifestHash, actual: t.manifestHash });

      // Hashes recomputed from fixed ABI fields (packages/schemas/src/hashing.ts); never trusted from the wire.
      const termsHash = computeTermsHash({
        token: t.token,
        amountAtomic: t.amount,
        bondAtomic: t.bond,
        manifestHash: t.manifestHash,
        rootPlain: t.rootPlain,
        rootCipher: t.rootCipher,
        keyCommitment: t.keyCommitment,
        revealDeadline: t.revealDeadline,
        challengeWindow: t.challengeWindow,
        sourceKey: t.sourceKey,
        minTimestamp: t.minTimestamp,
        chunkCount: String(t.chunkCount),
      });
      if (termsHash !== t.termsHash) fail("termsHash does not match the terms", { computed: termsHash, actual: t.termsHash });
      const orderId = computeOrderId({
        missionId: input.mission.id,
        resourceId: input.resource.id,
        buyer: treasury,
        seller: t.seller,
        amountAtomic: t.amount,
        termsHash,
        salt: order.salt,
      });
      if (orderId !== order.orderId || orderId !== t.orderId) fail("orderId does not match the terms", { computed: orderId, actual: order.orderId, inTerms: t.orderId });

      const nowDate = now();
      const revealDeadlineMs = Number(BigInt(t.revealDeadline) * 1000n);
      if (BigInt(t.revealDeadline) <= BigInt(Math.floor(nowDate.getTime() / 1000))) fail("revealDeadline has passed", { revealDeadline: t.revealDeadline });

      // The escrow is the order: it must exist and be the factory's prediction for these exact terms.
      let isEscrow: boolean;
      let predicted: Address;
      try {
        [isEscrow, predicted] = await Promise.all([opts.reads.isEscrow(order.escrowAddress), opts.reads.predict(orderId, termsHash)]);
      } catch (e) {
        return fail("factory read failed", { error: e instanceof Error ? e.message : String(e) });
      }
      if (!isEscrow) fail("factory does not know this escrow", { escrowAddress: order.escrowAddress });
      if (!sameAddress(predicted, order.escrowAddress)) fail("escrow address is not predict(orderId, termsHash)", { predicted, actual: order.escrowAddress });

      const authorizationExpiresAt = new Date(Math.min(revealDeadlineMs, nowDate.getTime() + QUOTE_TIMEOUT_SECONDS * 1000)).toISOString();
      log(`[order-terms:SIMULATED] order ${orderId.slice(0, 10)} escrow ${order.escrowAddress} seller ${t.seller} ${t.amount} atomic${order.replayed ? " (replayed)" : ""}`);
      const escrowAddress: Address = order.escrowAddress;
      const orderIdBytes32: Hex = orderId;
      return {
        sellerAddress: t.seller,
        escrowAddress,
        termsHash,
        orderIdBytes32,
        authorizationExpiresAt,
        simulated: true,
        escrow: {
          orderIdBytes32,
          escrowAddress,
          sellerAddress: t.seller,
          amountAtomic: t.amount,
          bondAtomic: t.bond,
          termsHash,
          manifestHash: t.manifestHash,
          rootPlain: t.rootPlain,
          rootCipher: t.rootCipher,
          keyCommitment: t.keyCommitment,
          revealDeadline: t.revealDeadline,
          challengeWindow: t.challengeWindow,
          sourceKey: t.sourceKey,
          minTimestamp: t.minTimestamp,
        },
      };
    },
  };
}
