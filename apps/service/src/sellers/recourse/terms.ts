import { buildTree, DATA_BYTES, encryptDataset, hashLeaf, keyCommitment, perBuyerKey, TIMESTAMP_BYTES } from "@overflow/recourse-crypto";
import { bigIntToAtomic, computeOrderId, computeTermsHash, USDC, type Address, type Hex } from "@overflow/schemas";
import { keccak256 } from "viem";
import type { RecourseListing } from "./datasets.js";
import { OrderTermsWireSchema, type OrderTermsWire, type SellerBehavior } from "./protocol.js";

// ---------------------------------------------------------------------------
// Pure order-terms builder for the SIMULATED Recourse sellers. `swap` tampers
// exactly one plaintext chunk on the CIPHER side only: rootPlain stays the true
// manifest root, so the committed promise is honest and the delivery is not;
// that is what the buyer's post-reveal decrypt + complainMismatch catches.
// ---------------------------------------------------------------------------

export interface BuildOrderConfig {
  bondBps: number;
  revealWindowS: number;
  challengeWindowS: number;
  swapIndex?: number | null | undefined;
}

export interface BuildOrderInput {
  listing: RecourseListing;
  buyer: Address;
  missionId: string;
  seller: Address;
  sellerSecret: Hex;
  salt: Hex;
  nowSeconds: bigint;
  config: BuildOrderConfig;
  behavior: SellerBehavior;
}

export interface BuiltOrder {
  terms: OrderTermsWire;
  /** The per-buyer key; stays server-side until revealKey() lands on chain. */
  k: Hex;
  cipherChunks: Uint8Array[];
  /** Index of the tampered chunk for `swap`; null otherwise. */
  swapIndex: number | null;
}

export function swapIndexFor(salt: Hex, chunkCount: number): number {
  return Number(BigInt(keccak256(salt)) % BigInt(chunkCount));
}

/** Flips bytes inside the 87-byte data region; length stays 160 so the chunk still parses. */
export function tamperChunk(chunk: Uint8Array): Uint8Array {
  const out = new Uint8Array(chunk);
  const end = Math.min(TIMESTAMP_BYTES + 8, TIMESTAMP_BYTES + DATA_BYTES);
  for (let i = TIMESTAMP_BYTES; i < end; i++) out[i] = (out[i]! ^ 0x5a) & 0xff;
  return out;
}

export function bondFor(amount: bigint, bondBps: number): bigint {
  return (amount * BigInt(bondBps)) / 10_000n;
}

export function buildOrder(input: BuildOrderInput): BuiltOrder {
  const { listing, buyer, missionId, seller, sellerSecret, salt, nowSeconds, config, behavior } = input;
  const { manifest } = listing;
  const chunkCount = manifest.chunkCount;
  const k = perBuyerKey(sellerSecret, salt, buyer);

  let plainForCipher: readonly Uint8Array[] = listing.plainChunks;
  let swapIndex: number | null = null;
  if (behavior === "swap") {
    swapIndex = config.swapIndex ?? swapIndexFor(salt, chunkCount);
    if (swapIndex < 0 || swapIndex >= chunkCount) throw new Error(`swapIndex ${swapIndex} out of range for ${chunkCount} chunks`);
    const copy = [...listing.plainChunks];
    copy[swapIndex] = tamperChunk(copy[swapIndex]!);
    plainForCipher = copy;
  }
  const cipherChunks = encryptDataset(plainForCipher, k);
  const rootCipher = buildTree(cipherChunks.map(hashLeaf)).root;

  const amount = BigInt(listing.priceAtomic);
  const bond = bondFor(amount, config.bondBps);
  const common = {
    token: USDC.address,
    amountAtomic: bigIntToAtomic(amount),
    bondAtomic: bigIntToAtomic(bond),
    manifestHash: listing.manifestHash,
    rootPlain: manifest.rootPlain,
    rootCipher,
    keyCommitment: keyCommitment(k),
    revealDeadline: (nowSeconds + BigInt(config.revealWindowS)).toString(10),
    challengeWindow: BigInt(config.challengeWindowS).toString(10),
    sourceKey: manifest.sourceKey,
    minTimestamp: String(manifest.minTimestamp),
    chunkCount: String(chunkCount),
  };
  const termsHash = computeTermsHash(common);
  const orderId = computeOrderId({ missionId, resourceId: listing.id, buyer, seller, amountAtomic: common.amountAtomic, termsHash, salt });

  const terms = OrderTermsWireSchema.parse({
    orderId,
    buyer,
    seller,
    token: common.token,
    amount: common.amountAtomic,
    bond: common.bondAtomic,
    termsHash,
    manifestHash: common.manifestHash,
    rootPlain: common.rootPlain,
    rootCipher,
    keyCommitment: common.keyCommitment,
    revealDeadline: common.revealDeadline,
    challengeWindow: common.challengeWindow,
    sourceKey: common.sourceKey,
    minTimestamp: common.minTimestamp,
    chunkCount,
  });
  return { terms, k, cipherChunks, swapIndex };
}
