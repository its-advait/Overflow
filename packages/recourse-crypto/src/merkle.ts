import { concat, keccak256, type Hex } from "viem";
import { Bytes32Schema } from "@overflow/schemas";
import { toBytes } from "./bytes";

// ---------------------------------------------------------------------------
// Merkle trees (README "Merkle trees"; the Solidity escrow mirrors these rules).
//
//   leaf   = keccak256(chunk bytes)
//   parent = keccak256(abi.encodePacked(left, right)) in index order
//   a level with an odd count carries its last node up unchanged
//   proof  = sibling hashes bottom-up; a carried level contributes nothing
// ---------------------------------------------------------------------------

export interface MerkleTree {
  leaves: Hex[];
  /** layers[0] = leaves, layers[last] = [root]. */
  layers: Hex[][];
  root: Hex;
}

/** Indices are chunk positions; 2^31 chunks is far beyond any dataset here. */
const MAX_INDEX = 2 ** 31 - 1;

function assertIndex(index: number, what = "index"): void {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) throw new Error(`${what} must be an integer in [0, 2^31)`);
}

export function hashLeaf(chunk: Hex | Uint8Array): Hex {
  return keccak256(toBytes(chunk));
}

export function hashPair(left: Hex, right: Hex): Hex {
  return keccak256(concat([Bytes32Schema.parse(left), Bytes32Schema.parse(right)]));
}

export function buildTree(leaves: readonly Hex[]): MerkleTree {
  if (leaves.length === 0) throw new Error("a Merkle tree needs at least one leaf");
  if (leaves.length - 1 > MAX_INDEX) throw new Error("too many leaves");
  const layers: Hex[][] = [leaves.map((l) => Bytes32Schema.parse(l))];
  while ((layers[layers.length - 1] as Hex[]).length > 1) {
    const prev = layers[layers.length - 1] as Hex[];
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i] as Hex;
      const right = prev[i + 1];
      next.push(right === undefined ? left : hashPair(left, right));
    }
    layers.push(next);
  }
  return { leaves: layers[0] as Hex[], layers, root: (layers[layers.length - 1] as Hex[])[0] as Hex };
}

export function buildTreeFromChunks(chunks: readonly (Hex | Uint8Array)[]): MerkleTree {
  return buildTree(chunks.map(hashLeaf));
}

/** Sibling hashes from the leaf up. A level where the node is the odd last one adds nothing. */
export function getProof(tree: MerkleTree, index: number): Hex[] {
  assertIndex(index);
  if (index >= tree.leaves.length) throw new Error(`index ${index} out of range for ${tree.leaves.length} leaves`);
  const proof: Hex[] = [];
  let idx = index;
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level] as Hex[];
    const sibling = idx ^ 1;
    if (sibling < layer.length) proof.push(layer[sibling] as Hex);
    idx >>= 1;
  }
  return proof;
}

/** Number of proof elements a correct proof has for `index` in a tree of `leafCount` leaves. */
export function expectedProofLength(leafCount: number, index: number): number {
  assertIndex(index);
  if (!Number.isInteger(leafCount) || leafCount < 1) throw new Error("leafCount must be a positive integer");
  if (index >= leafCount) throw new Error(`index ${index} out of range for ${leafCount} leaves`);
  let n = leafCount;
  let idx = index;
  let len = 0;
  while (n > 1) {
    if ((idx ^ 1) < n) len++;
    idx >>= 1;
    n = Math.ceil(n / 2);
  }
  return len;
}

function bitLength(x: number): number {
  return x === 0 ? 0 : 32 - Math.clz32(x);
}

/**
 * Recomputes the root from (leaf, index, proof) without knowing the leaf count.
 *
 * Why this is well defined: a node that is the odd last one at some level stays
 * the last one at every level above, so the carried levels are exactly the
 * even-position levels at or above the first "last" level. Given the proof
 * length, the tree depth is max(bitLength(index), proof.length) and the number
 * of carried levels is depth - proof.length; they occupy the topmost
 * even-position levels of the path. Returns undefined for an impossible shape.
 */
export function computeRootFromProof(leaf: Hex, index: number, proof: readonly Hex[]): Hex | undefined {
  assertIndex(index);
  Bytes32Schema.parse(leaf);
  const depth = Math.max(bitLength(index), proof.length);
  let carries = depth - proof.length;
  let carryMask = 0;
  for (let level = depth - 1; level >= 0 && carries > 0; level--) {
    if (((index >> level) & 1) === 0) {
      carryMask |= 1 << level;
      carries--;
    }
  }
  if (carries > 0) return undefined;
  let node = leaf;
  let p = 0;
  for (let level = 0; level < depth; level++) {
    if (carryMask & (1 << level)) continue;
    const sibling = Bytes32Schema.parse(proof[p++] as Hex);
    node = (index >> level) & 1 ? hashPair(sibling, node) : hashPair(node, sibling);
  }
  return node;
}

export interface VerifyProofInput {
  root: Hex;
  leaf: Hex;
  index: number;
  proof: readonly Hex[];
  /**
   * When known, pins the tree shape: the proof must have exactly the length a
   * tree of this size produces for `index`. Without it a bare leaf hash that is
   * really an internal node could verify with a shorter proof (classic Merkle
   * second-preimage). Chunk hashes of real 160-byte chunks are never internal
   * nodes, so chunk-backed proofs are safe either way; bare `plainLeaf` values
   * in complainMismatch should be pinned (leafCount or equal proof lengths).
   */
  leafCount?: number;
}

export function verifyProof({ root, leaf, index, proof, leafCount }: VerifyProofInput): boolean {
  Bytes32Schema.parse(root);
  if (leafCount !== undefined) {
    if (!Number.isInteger(leafCount) || leafCount < 1 || index >= leafCount) return false;
    if (proof.length !== expectedProofLength(leafCount, index)) return false;
  }
  const computed = computeRootFromProof(leaf, index, proof);
  return computed !== undefined && computed.toLowerCase() === root.toLowerCase();
}
