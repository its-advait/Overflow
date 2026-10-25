import { concat, keccak256, type Hex } from "viem";
import { Bytes32Schema } from "@overflow/schemas";
import { toBytes } from "./bytes";
import { CHUNK_BYTES } from "./record";

// ---------------------------------------------------------------------------
// Merkle trees (README "Merkle trees"; the Solidity escrow mirrors these rules).
//
//   leaf   = keccak256(0x00 || chunk)              chunk is exactly 160 bytes
//   parent = keccak256(0x01 || left || right)      in index order
//   a level with an odd count carries its last node up unchanged
//   proof  = sibling hashes bottom-up; a carried level contributes nothing
//
// Leaves and internal nodes live in different hash domains, and every verifier
// knows chunkCount, so the proof length is pinned for each index. Together
// these close the internal-node-as-leaf second preimage.
// ---------------------------------------------------------------------------

export const LEAF_PREFIX = 0x00;
export const NODE_PREFIX = 0x01;

export interface MerkleTree {
  leaves: Hex[];
  /** layers[0] = leaves, layers[last] = [root]. */
  layers: Hex[][];
  root: Hex;
  chunkCount: number;
}

/** Indices are chunk positions; 2^31 chunks is far beyond any dataset here. */
const MAX_INDEX = 2 ** 31 - 1;

function assertIndex(index: number, what = "index"): void {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) throw new Error(`${what} must be an integer in [0, 2^31)`);
}

function assertChunkCount(chunkCount: number): void {
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount - 1 > MAX_INDEX) {
    throw new Error("chunkCount must be a positive integer below 2^31");
  }
}

/** leaf = keccak256(0x00 || chunk). The chunk must be exactly 160 bytes. */
export function hashLeaf(chunk: Hex | Uint8Array): Hex {
  const bytes = toBytes(chunk);
  if (bytes.length !== CHUNK_BYTES) throw new Error(`leaf chunk must be ${CHUNK_BYTES} bytes, got ${bytes.length}`);
  return keccak256(concat([new Uint8Array([LEAF_PREFIX]), bytes]));
}

/** parent = keccak256(0x01 || left || right). */
export function hashPair(left: Hex, right: Hex): Hex {
  return keccak256(concat([new Uint8Array([NODE_PREFIX]), toBytes(Bytes32Schema.parse(left)), toBytes(Bytes32Schema.parse(right))]));
}

export function buildTree(leaves: readonly Hex[]): MerkleTree {
  assertChunkCount(leaves.length);
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
  return { leaves: layers[0] as Hex[], layers, root: (layers[layers.length - 1] as Hex[])[0] as Hex, chunkCount: leaves.length };
}

export function buildTreeFromChunks(chunks: readonly (Hex | Uint8Array)[]): MerkleTree {
  return buildTree(chunks.map(hashLeaf));
}

/** Sibling hashes from the leaf up. A level where the node is the odd last one adds nothing. */
export function getProof(tree: MerkleTree, index: number): Hex[] {
  assertIndex(index);
  if (index >= tree.chunkCount) throw new Error(`index ${index} out of range for ${tree.chunkCount} chunks`);
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

/**
 * Number of proof elements a correct proof has for `index` in a tree of
 * `chunkCount` leaves with odd-node carry-up. Solidity mirror:
 *
 *   uint256 n = chunkCount; uint256 idx = index; uint256 len = 0;
 *   while (n > 1) { if ((idx ^ 1) < n) len++; idx >>= 1; n = (n + 1) / 2; }
 */
export function expectedProofLength(index: number, chunkCount: number): number {
  assertIndex(index);
  assertChunkCount(chunkCount);
  if (index >= chunkCount) throw new Error(`index ${index} out of range for ${chunkCount} chunks`);
  let n = chunkCount;
  let idx = index;
  let len = 0;
  while (n > 1) {
    if ((idx ^ 1) < n) len++;
    idx >>= 1;
    n = Math.ceil(n / 2);
  }
  return len;
}

/**
 * Recomputes the root for a known tree shape. Returns undefined when the proof
 * length does not match the shape or the index is out of range. Solidity mirror:
 *
 *   node = leaf; n = chunkCount; idx = index; p = 0;
 *   while (n > 1) {
 *     if ((idx ^ 1) < n) { sib = proof[p++]; node = idx & 1 ? H(sib, node) : H(node, sib); }
 *     idx >>= 1; n = (n + 1) / 2;
 *   }
 *   require(p == proof.length);
 */
export function computeRootFromProof(leaf: Hex, index: number, proof: readonly Hex[], chunkCount: number): Hex | undefined {
  assertIndex(index);
  assertChunkCount(chunkCount);
  Bytes32Schema.parse(leaf);
  if (index >= chunkCount) return undefined;
  let node = leaf;
  let n = chunkCount;
  let idx = index;
  let p = 0;
  while (n > 1) {
    if ((idx ^ 1) < n) {
      const sibling = proof[p++];
      if (sibling === undefined) return undefined;
      node = idx & 1 ? hashPair(sibling, node) : hashPair(node, sibling);
    }
    idx >>= 1;
    n = Math.ceil(n / 2);
  }
  if (p !== proof.length) return undefined;
  return node;
}

export interface VerifyProofInput {
  root: Hex;
  leaf: Hex;
  index: number;
  proof: readonly Hex[];
  /** Chunk count from the escrow terms / manifest. Pins the proof length for `index`. */
  chunkCount: number;
}

/** True iff `index < chunkCount`, `proof.length == expectedProofLength(index, chunkCount)` and the recomputed root matches. */
export function verifyProof({ root, leaf, index, proof, chunkCount }: VerifyProofInput): boolean {
  Bytes32Schema.parse(root);
  assertIndex(index);
  assertChunkCount(chunkCount);
  if (index >= chunkCount) return false;
  if (proof.length !== expectedProofLength(index, chunkCount)) return false;
  const computed = computeRootFromProof(leaf, index, proof, chunkCount);
  return computed !== undefined && computed.toLowerCase() === root.toLowerCase();
}
