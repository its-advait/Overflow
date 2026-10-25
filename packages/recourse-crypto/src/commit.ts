import type { Address, Hex } from "viem";
import { AddressSchema, Bytes32Schema } from "@overflow/schemas";
import { toBytes } from "./bytes";
import { encryptDataset, keyCommitment, perBuyerKey } from "./keys";
import { buildTree, hashLeaf, type MerkleTree } from "./merkle";
import { CHUNK_BYTES } from "./record";

// ---------------------------------------------------------------------------
// Seller commitment: rootPlain, rootCipher, keyCommitment (+ leafCount for the
// manifest). These three values go into the escrow terms; the manifest also
// publishes every plain leaf so the buyer can prove a mismatch later.
// ---------------------------------------------------------------------------

export interface SellerCommitment {
  rootPlain: Hex;
  rootCipher: Hex;
  keyCommitment: Hex;
  /** Number of 160-byte chunks; published in the manifest, not derivable from the roots. */
  leafCount: number;
}

export interface CommittedDataset extends SellerCommitment {
  /** k: seller-side secret for this order; revealed onchain after funding. */
  perBuyerKey: Hex;
  plainChunks: Uint8Array[];
  cipherChunks: Uint8Array[];
  plainLeaves: Hex[];
  cipherLeaves: Hex[];
  plainTree: MerkleTree;
  cipherTree: MerkleTree;
}

export interface CommitInput {
  plainChunks: readonly (Hex | Uint8Array)[];
  sellerSecret: Hex;
  orderId: Hex;
  buyer: Address;
}

export function commitDataset({ plainChunks, sellerSecret, orderId, buyer }: CommitInput): CommittedDataset {
  const plain = plainChunks.map((c) => {
    const b = toBytes(c);
    if (b.length !== CHUNK_BYTES) throw new Error(`every chunk must be ${CHUNK_BYTES} bytes`);
    return b;
  });
  if (plain.length === 0) throw new Error("dataset has no chunks");
  const k = perBuyerKey(Bytes32Schema.parse(sellerSecret), Bytes32Schema.parse(orderId), AddressSchema.parse(buyer));
  const cipher = encryptDataset(plain, k);
  const plainLeaves = plain.map(hashLeaf);
  const cipherLeaves = cipher.map(hashLeaf);
  const plainTree = buildTree(plainLeaves);
  const cipherTree = buildTree(cipherLeaves);
  return {
    rootPlain: plainTree.root,
    rootCipher: cipherTree.root,
    keyCommitment: keyCommitment(k),
    leafCount: plain.length,
    perBuyerKey: k,
    plainChunks: plain,
    cipherChunks: cipher,
    plainLeaves,
    cipherLeaves,
    plainTree,
    cipherTree,
  };
}

/** Buyer, before funding: every downloaded ciphertext chunk must Merkle to rootCipher. */
export function verifyCiphertext(cipherChunks: readonly (Hex | Uint8Array)[], rootCipher: Hex): boolean {
  if (cipherChunks.length === 0) return false;
  return buildTree(cipherChunks.map(hashLeaf)).root === Bytes32Schema.parse(rootCipher).toLowerCase();
}

/** Buyer: the published plain leaves must Merkle to rootPlain. */
export function verifyPlainLeaves(plainLeaves: readonly Hex[], rootPlain: Hex): boolean {
  if (plainLeaves.length === 0) return false;
  return buildTree(plainLeaves).root === Bytes32Schema.parse(rootPlain).toLowerCase();
}
