import { buildTree, encryptDataset, getProof, hashLeaf, keyCommitment, revealChunkKeys, type MerkleTree } from "@overflow/recourse-crypto";
import type { Address, Hex } from "@overflow/schemas";
import { concatHex, keccak256, stringToHex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { LoadedDataset } from "./dataset.js";
import { drawSample } from "./evidence.js";

// ---------------------------------------------------------------------------
// SIMULATED sellers for the local recourse run (docs/SPEC.md "Demo script").
// Three behaviours over the same protocol:
//   honest  commits truthfully, reveals on time, gets paid
//   ghost   commits truthfully, never reveals; the buyer claims the timeout refund
//   swap    commits a ciphertext tree with one swapped chunk, reveals, and is
//           caught by complainMismatch; price + bond return to the treasury
// The swap seller knows which chunks the buyer will sample (the sample
// randomness is deterministic from the order salt in this SIMULATED run) so it
// swaps a chunk the sample misses, exactly the attack the SPEC's demo stages.
// No seller here speaks HTTP; run.ts drives them in-process.
// ---------------------------------------------------------------------------

export type SellerBehaviour = "honest" | "ghost" | "swap";

export const SIMULATED_SELLER_LABEL: Record<SellerBehaviour, string> = {
  honest: "SIMULATED honest seller",
  ghost: "SIMULATED ghost seller (never reveals)",
  swap: "SIMULATED swap seller (swaps a chunk the sample misses; knows the sample to keep the demo deterministic)",
};

export interface SellerOrder {
  rootCipher: Hex;
  rootPlain: Hex;
  keyCommitment: Hex;
  chunkCount: number;
  /** The ciphertext as served to the buyer (for the swap seller, with one chunk replaced). */
  cipherChunks: Uint8Array[];
  cipherTree: MerkleTree;
  /** Index the swap seller corrupted; undefined for honest and ghost. */
  swappedIndex: number | undefined;
}

export interface SimSeller {
  behaviour: SellerBehaviour;
  label: string;
  account: PrivateKeyAccount;
  address: Address;
  dataset: LoadedDataset;
  /** Commit for one order: k = keccak256(secret || salt || buyer). The buyer learns only the roots and the commitment. */
  createOrder(input: { salt: Hex; buyer: Address; sampleCount: number; sampleRandomness: Hex }): SellerOrder;
  /** Whether this seller will call revealKey after funding. */
  willReveal(): boolean;
  /** k for the order; only the seller knows it until revealKey. */
  keyFor(input: { salt: Hex; buyer: Address }): Hex;
}

/** 160 bytes of SIMULATED garbage for the swapped chunk, derived so the fixture is reproducible. */
function garbageChunk(k: Hex, index: number): Uint8Array {
  const out = new Uint8Array(160);
  for (let j = 0; j < 5; j++) {
    const block = keccak256(concatHex([k, stringToHex(`SIMULATED-swapped-chunk-${index}-${j}`)]));
    out.set(Buffer.from(block.slice(2), "hex"), j * 32);
  }
  return out;
}

export function createSimSeller(input: { behaviour: SellerBehaviour; account: PrivateKeyAccount; dataset: LoadedDataset; secret: Hex }): SimSeller {
  const { behaviour, account, dataset, secret } = input;
  const keyFor = ({ salt, buyer }: { salt: Hex; buyer: Address }): Hex => keccak256(concatHex([secret, salt, buyer]));
  return {
    behaviour,
    label: SIMULATED_SELLER_LABEL[behaviour],
    account,
    address: account.address,
    dataset,
    keyFor,
    willReveal: () => behaviour !== "ghost",
    createOrder({ salt, buyer, sampleCount, sampleRandomness }) {
      const k = keyFor({ salt, buyer });
      const cipherChunks = encryptDataset(dataset.plainChunks, k);
      let swappedIndex: number | undefined;
      if (behaviour === "swap") {
        // Swap the smallest index the buyer's sample will not touch.
        const sampled = new Set(drawSample(sampleCount, dataset.manifest.chunkCount, sampleRandomness));
        swappedIndex = Array.from({ length: dataset.manifest.chunkCount }, (_, i) => i).find((i) => !sampled.has(i));
        if (swappedIndex === undefined) throw new Error("every chunk is sampled; nothing to swap");
        cipherChunks[swappedIndex] = garbageChunk(k, swappedIndex);
      }
      const cipherTree = buildTree(cipherChunks.map(hashLeaf));
      return {
        rootCipher: cipherTree.root,
        rootPlain: dataset.manifest.rootPlain,
        keyCommitment: keyCommitment(k),
        chunkCount: dataset.manifest.chunkCount,
        cipherChunks,
        cipherTree,
        swappedIndex,
      };
    },
  };
}

/** Seller side of the sample: k_i for each sampled index and the two proofs the buyer will verify. */
export function sampleFor(seller: SimSeller, order: SellerOrder, k: Hex, indices: readonly number[]) {
  return {
    revealed: revealChunkKeys(k, indices),
    cipherProofs: indices.map((i) => getProof(order.cipherTree, i)),
    plainProofs: indices.map((i) => getProof(seller.dataset.plainTree, i)),
  };
}
