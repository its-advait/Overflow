import { computeOrderId, computeTermsHash, USDC, type Address, type Hex } from "@overflow/schemas";
import { concatHex, getAddress, keccak256 } from "viem";
import type { RecourseChainReads } from "../sellers/recourse/chain.js";
import type { CreateOrderBody, CreateOrderResponse } from "../sellers/recourse/protocol.js";
import { b32, SELLER } from "../test-db.js";

// Test-only: a fake SIMULATED Recourse seller behind `fetch` and the fake factory reads that agree with it.
// Hashes are the real computeTermsHash / computeOrderId over fixed ABI fields; only the chain is faked.

/** Deterministic fake escrow address for (orderId, termsHash); the fake factory "predicts" the same. */
export const fakeEscrowAddress = (orderId: Hex, termsHash: Hex): Address => getAddress(`0x${keccak256(concatHex([orderId, termsHash])).slice(-40)}`);

export interface FakeSellerOptions {
  /** Listing lookup: price and manifest the terms must match. */
  listing: (resourceId: string) => Promise<{ priceAtomic: string; manifestHash: Hex } | undefined> | { priceAtomic: string; manifestHash: Hex } | undefined;
  now: () => Date;
  seller?: Address | undefined;
  salt?: Hex | undefined;
  /** Edits the valid response before it is sent (to build each failure case). */
  mutate?: ((r: CreateOrderResponse) => CreateOrderResponse) | undefined;
  /** HTTP status to answer instead of 201 (e.g. 500). */
  status?: number | undefined;
}

export function fakeRecourseSeller(opts: FakeSellerOptions) {
  const calls: CreateOrderBody[] = [];
  const created = new Set<string>();
  const seller = opts.seller ?? SELLER;
  const salt = opts.salt ?? b32(77);

  async function order(body: CreateOrderBody): Promise<CreateOrderResponse> {
    const listing = await opts.listing(body.resourceId);
    if (!listing) throw new Error(`fake seller: unknown resource ${body.resourceId}`);
    const nowS = BigInt(Math.floor(opts.now().getTime() / 1000));
    const terms = {
      buyer: body.buyerTreasury,
      seller,
      token: USDC.address,
      amount: listing.priceAtomic,
      bond: String((BigInt(listing.priceAtomic) * 2000n) / 10000n),
      manifestHash: listing.manifestHash,
      rootPlain: b32(0xa1),
      rootCipher: b32(0xa2),
      keyCommitment: b32(0xa3),
      revealDeadline: String(nowS + 600n),
      challengeWindow: "300",
      sourceKey: "0x5555555555555555555555555555555555555555" as Address,
      minTimestamp: "1609459200",
      chunkCount: 48,
    };
    const termsHash = computeTermsHash({
      token: terms.token,
      amountAtomic: terms.amount,
      bondAtomic: terms.bond,
      manifestHash: terms.manifestHash,
      rootPlain: terms.rootPlain,
      rootCipher: terms.rootCipher,
      keyCommitment: terms.keyCommitment,
      revealDeadline: terms.revealDeadline,
      challengeWindow: terms.challengeWindow,
      sourceKey: terms.sourceKey,
      minTimestamp: terms.minTimestamp,
      chunkCount: String(terms.chunkCount),
    });
    const orderId = computeOrderId({ missionId: body.missionId, resourceId: body.resourceId, buyer: body.buyerTreasury, seller, amountAtomic: terms.amount, termsHash, salt });
    const escrowAddress = fakeEscrowAddress(orderId, termsHash);
    created.add(escrowAddress.toLowerCase());
    return {
      simulated: true,
      orderId,
      escrowAddress,
      sellerId: "seller-honest",
      resourceId: body.resourceId,
      missionId: body.missionId,
      salt,
      terms: { ...terms, orderId, termsHash },
      createTxHash: b32(0xbb),
      replayed: false,
      cipherUrl: `/orders/${orderId}/cipher`,
      sampleUrl: `/orders/${orderId}/sample`,
      resourceUrl: `/orders/${orderId}/resource`,
    };
  }

  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (!url.endsWith("/orders") || init.method !== "POST") return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const body = JSON.parse(String(init.body)) as CreateOrderBody;
    calls.push(body);
    if (opts.status && opts.status !== 201) return new Response(JSON.stringify({ simulated: true, error: "fake seller failure" }), { status: opts.status });
    const response = await order(body);
    return new Response(JSON.stringify(opts.mutate ? opts.mutate(response) : response), { status: 201, headers: { "content-type": "application/json" } });
  };

  /** Fake factory reads agreeing with the fake seller: every created escrow isEscrow, predict is the deterministic address. */
  const reads: Pick<RecourseChainReads, "isEscrow" | "predict"> = {
    isEscrow: async (address) => created.has(address.toLowerCase()),
    predict: async (orderId, termsHash) => fakeEscrowAddress(orderId, termsHash),
  };

  return { fetch, reads, calls, created };
}
