import { keccak256, type Hex } from "viem";
import { Bytes32Schema } from "@overflow/schemas";
import { concatBytes, toBytes, uint256Bytes } from "./bytes";
import { chunkKey, decryptChunkWithChunkKey } from "./keys";
import { hashLeaf, verifyProof } from "./merkle";

// ---------------------------------------------------------------------------
// Sampling before buying (docs/SPEC.md). The buyer picks indices from
// randomness the seller could not predict; the seller reveals only those k_i.
// ---------------------------------------------------------------------------

/**
 * Deterministic unique indices from `randomBytes`:
 * candidate_j = keccak256(randomBytes || uint256 j) mod n, skipping repeats.
 * Returned in draw order.
 */
export function pickSampleIndices(n: number, count: number, randomBytes: Hex | Uint8Array): number[] {
  if (!Number.isInteger(n) || n < 1) throw new Error("n must be a positive integer");
  if (!Number.isInteger(count) || count < 0 || count > n) throw new Error("count must be an integer in [0, n]");
  const seed = toBytes(randomBytes);
  if (seed.length === 0) throw new Error("randomBytes must not be empty");
  const picked: number[] = [];
  const seen = new Set<number>();
  for (let j = 0; picked.length < count; j++) {
    const digest = BigInt(keccak256(concatBytes(seed, uint256Bytes(j))));
    const candidate = Number(digest % BigInt(n));
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    picked.push(candidate);
  }
  return picked;
}

export interface RevealedChunkKey {
  index: number;
  chunkKey: Hex;
}

/** Seller side: reveal k_i for the sampled indices only. */
export function revealChunkKeys(k: Hex, indices: readonly number[]): RevealedChunkKey[] {
  return indices.map((index) => ({ index, chunkKey: chunkKey(k, index) }));
}

export interface SampleProofs {
  index: number;
  cipherProof: readonly Hex[];
  plainProof: readonly Hex[];
  rootCipher: Hex;
  rootPlain: Hex;
  /** Chunk count from the manifest; pins the plain proof shape when known. */
  leafCount?: number;
}

export type SampleVerdict =
  | { ok: true; plainChunk: Uint8Array; plainLeaf: Hex }
  | { ok: false; reason: "cipher-proof" | "plain-proof" | "decrypt-mismatch"; detail: string };

/**
 * Buyer side: the ciphertext chunk must prove under rootCipher, the published
 * plain leaf must prove under rootPlain, and decrypting with the revealed k_i
 * must hash to that plain leaf.
 */
export function verifySample(
  cipherChunk: Hex | Uint8Array,
  revealedChunkKey: Hex,
  plainLeaf: Hex,
  proofs: SampleProofs,
): SampleVerdict {
  const cipher = toBytes(cipherChunk);
  const cipherLeaf = hashLeaf(cipher);
  if (!verifyProof({ root: proofs.rootCipher, leaf: cipherLeaf, index: proofs.index, proof: proofs.cipherProof, leafCount: proofs.leafCount })) {
    return { ok: false, reason: "cipher-proof", detail: `ciphertext chunk ${proofs.index} does not prove under rootCipher` };
  }
  if (!verifyProof({ root: proofs.rootPlain, leaf: Bytes32Schema.parse(plainLeaf), index: proofs.index, proof: proofs.plainProof, leafCount: proofs.leafCount })) {
    return { ok: false, reason: "plain-proof", detail: `plain leaf ${proofs.index} does not prove under rootPlain` };
  }
  const plainChunk = decryptChunkWithChunkKey(cipher, revealedChunkKey);
  const derived = hashLeaf(plainChunk);
  if (derived.toLowerCase() !== plainLeaf.toLowerCase()) {
    return {
      ok: false,
      reason: "decrypt-mismatch",
      detail: `chunk ${proofs.index} decrypts to ${derived}, committed plain leaf is ${plainLeaf}`,
    };
  }
  return { ok: true, plainChunk, plainLeaf: derived };
}
