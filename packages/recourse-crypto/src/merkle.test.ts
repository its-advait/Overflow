import { concat, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { buildTree, buildTreeFromChunks, computeRootFromProof, expectedProofLength, getProof, hashLeaf, hashPair, verifyProof } from "./merkle";

const leaf = (n: number) => keccak256(toHex(n, { size: 32 }));
const leaves = (n: number) => Array.from({ length: n }, (_, i) => leaf(i));

describe("merkle", () => {
  it("leaf = keccak256(chunk), parent = keccak256(left || right)", () => {
    const chunk = new Uint8Array(160).fill(9);
    expect(hashLeaf(chunk)).toBe(keccak256(chunk));
    expect(hashPair(leaf(0), leaf(1))).toBe(keccak256(concat([leaf(0), leaf(1)])));
    expect(hashPair(leaf(0), leaf(1))).not.toBe(hashPair(leaf(1), leaf(0)));
    expect(buildTreeFromChunks([chunk]).root).toBe(keccak256(chunk));
  });

  it("carries the odd last node up unchanged (7 leaves)", () => {
    const l = leaves(7);
    const t = buildTree(l);
    const h01 = hashPair(l[0]!, l[1]!);
    const h23 = hashPair(l[2]!, l[3]!);
    const h45 = hashPair(l[4]!, l[5]!);
    const h6 = l[6]!;
    const h0123 = hashPair(h01, h23);
    const h456 = hashPair(h45, h6);
    expect(t.layers).toEqual([l, [h01, h23, h45, h6], [h0123, h456], [hashPair(h0123, h456)]]);
    expect(getProof(t, 6)).toEqual([h45, h0123]);
    expect(getProof(t, 6).length).toBe(2);
    expect(getProof(t, 5)).toEqual([l[4], h6, h0123]);
    expect(expectedProofLength(7, 6)).toBe(2);
    expect(expectedProofLength(7, 5)).toBe(3);
  });

  it("every index verifies for 1..20 leaves, with and without the leaf count", () => {
    for (let n = 1; n <= 20; n++) {
      const l = leaves(n);
      const t = buildTree(l);
      for (let i = 0; i < n; i++) {
        const proof = getProof(t, i);
        expect(proof.length).toBe(expectedProofLength(n, i));
        expect(verifyProof({ root: t.root, leaf: l[i]!, index: i, proof })).toBe(true);
        expect(verifyProof({ root: t.root, leaf: l[i]!, index: i, proof, leafCount: n })).toBe(true);
        // wrong index, wrong leaf, tampered proof, truncated proof
        expect(verifyProof({ root: t.root, leaf: l[i]!, index: (i + 1) % n, proof })).toBe(n === 1);
        expect(verifyProof({ root: t.root, leaf: leaf(1000 + i), index: i, proof })).toBe(false);
        if (proof.length > 0) {
          const tampered = [...proof];
          tampered[0] = leaf(999);
          expect(verifyProof({ root: t.root, leaf: l[i]!, index: i, proof: tampered })).toBe(false);
          expect(verifyProof({ root: t.root, leaf: l[i]!, index: i, proof: proof.slice(1), leafCount: n })).toBe(false);
        }
      }
    }
  });

  it("computeRootFromProof returns undefined for an impossible carry pattern", () => {
    // index 1 (odd at level 0) can never be carried, so a depth-1 path with zero proof elements is impossible
    expect(computeRootFromProof(leaf(0), 1, [])).toBeUndefined();
  });

  it("pinning leafCount rejects the internal-node-as-leaf second preimage", () => {
    const l = leaves(4);
    const t = buildTree(l);
    const internal = hashPair(l[0]!, l[1]!);
    const shortProof = [hashPair(l[2]!, l[3]!)];
    // Without a leaf count the shorter proof is interpreted as a 2-leaf tree and verifies.
    expect(verifyProof({ root: t.root, leaf: internal, index: 0, proof: shortProof })).toBe(true);
    // With the chunk count from the manifest, the shape is pinned and it fails.
    expect(verifyProof({ root: t.root, leaf: internal, index: 0, proof: shortProof, leafCount: 4 })).toBe(false);
  });

  it("rejects empty trees and out-of-range indices", () => {
    expect(() => buildTree([])).toThrow();
    const t = buildTree(leaves(3));
    expect(() => getProof(t, 3)).toThrow();
    expect(() => getProof(t, -1)).toThrow();
    expect(() => getProof(t, 1.5)).toThrow();
    expect(verifyProof({ root: t.root, leaf: leaf(0), index: 3, proof: [], leafCount: 3 })).toBe(false);
  });
});
