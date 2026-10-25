import { concatHex, keccak256, type Hex } from "viem";

/**
 * Domain-separated, index-ordered Merkle tree over chunk records. Mirrors contracts/src/MerkleLib.sol:
 *   leaf = keccak256(0x00 || data), node = keccak256(0x01 || left || right)
 * Levels are built left to right; an unpaired last node is promoted unhashed to the next level, so the
 * proof length depends on the leaf index (see expectedProofLength). Golden vectors in merkle.test.ts and
 * contracts/test/escrow/MerkleLib.t.sol keep the two implementations identical.
 */

/** Record size in bytes (for example a 95-byte payload plus a 65-byte signature). */
export const CHUNK_SIZE = 160 as const;
export const LEAF_PREFIX = "0x00" as const;
export const NODE_PREFIX = "0x01" as const;

export function hashLeaf(data: Hex): Hex {
  return keccak256(concatHex([LEAF_PREFIX, data]));
}

export function hashNode(left: Hex, right: Hex): Hex {
  return keccak256(concatHex([NODE_PREFIX, left, right]));
}

/** keyCommitment = keccak256(key) for a bytes32 key. */
export function keyCommitment(key: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("key must be bytes32");
  return keccak256(key);
}

function assertIndex(i: number, n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new Error("n must be a positive integer");
  if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`index ${i} out of range for ${n} leaves`);
}

/** True when the node at `idx` is the unpaired last node of a level of `width` nodes. */
function promoted(idx: number, width: number): boolean {
  return idx === width - 1 && width % 2 === 1;
}

/** Number of sibling hashes a proof for leaf `i` of an `n`-leaf tree must contain. */
export function expectedProofLength(i: number, n: number): number {
  assertIndex(i, n);
  let len = 0;
  let width = n;
  let idx = i;
  while (width > 1) {
    if (!promoted(idx, width)) len++;
    idx >>= 1;
    width = (width + 1) >> 1;
  }
  return len;
}

function nextLevel(level: readonly Hex[]): Hex[] {
  const next: Hex[] = [];
  for (let j = 0; j < level.length; j += 2) {
    const l = level[j] as Hex;
    const r = level[j + 1];
    next.push(r === undefined ? l : hashNode(l, r));
  }
  return next;
}

/** Merkle root of already-hashed leaves (use hashLeaf first). */
export function merkleRoot(leaves: readonly Hex[]): Hex {
  if (leaves.length === 0) throw new Error("no leaves");
  let level: Hex[] = [...leaves];
  while (level.length > 1) level = nextLevel(level);
  return level[0] as Hex;
}

/** Sibling hashes for leaf `i`, bottom-up, skipping levels where the node is promoted. */
export function merkleProof(leaves: readonly Hex[], i: number): Hex[] {
  assertIndex(i, leaves.length);
  const proof: Hex[] = [];
  let level: Hex[] = [...leaves];
  let idx = i;
  while (level.length > 1) {
    const sibling = level[idx ^ 1];
    if (sibling !== undefined) proof.push(sibling);
    level = nextLevel(level);
    idx >>= 1;
  }
  return proof;
}

/** True iff `proof` (consumed exactly) lifts `leafHash` at index `i` of an `n`-leaf tree to `root`. */
export function verifyProof(proof: readonly Hex[], root: Hex, leafHash: Hex, i: number, n: number): boolean {
  if (!Number.isInteger(i) || !Number.isInteger(n) || i < 0 || i >= n) return false;
  let h = leafHash;
  let width = n;
  let idx = i;
  let p = 0;
  while (width > 1) {
    if (!promoted(idx, width)) {
      const sibling = proof[p++];
      if (sibling === undefined) return false;
      h = idx % 2 === 0 ? hashNode(h, sibling) : hashNode(sibling, h);
    }
    idx >>= 1;
    width = (width + 1) >> 1;
  }
  return p === proof.length && h.toLowerCase() === root.toLowerCase();
}
