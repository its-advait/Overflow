import { concat, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import {
  LEAF_PREFIX,
  NODE_PREFIX,
  buildTree,
  buildTreeFromChunks,
  computeRootFromProof,
  expectedProofLength,
  getProof,
  hashLeaf,
  hashPair,
  verifyProof,
} from "./merkle";

const leaf = (n: number) => keccak256(toHex(n, { size: 32 }));
const leaves = (n: number) => Array.from({ length: n }, (_, i) => leaf(i));

describe("merkle", () => {
  it("leaf = keccak256(0x00 || chunk), parent = keccak256(0x01 || left || right)", () => {
    const chunk = new Uint8Array(160).fill(9);
    expect(LEAF_PREFIX).toBe(0x00);
    expect(NODE_PREFIX).toBe(0x01);
    expect(hashLeaf(chunk)).toBe(keccak256(concat([new Uint8Array([0x00]), chunk])));
    expect(hashLeaf(chunk)).not.toBe(keccak256(chunk));
    expect(hashPair(leaf(0), leaf(1))).toBe(keccak256(concat(["0x01", leaf(0), leaf(1)])));
    expect(hashPair(leaf(0), leaf(1))).not.toBe(hashPair(leaf(1), leaf(0)));
    expect(buildTreeFromChunks([chunk]).root).toBe(hashLeaf(chunk));
  });

  it("rejects chunks that are not exactly 160 bytes", () => {
    expect(() => hashLeaf(new Uint8Array(159))).toThrow(/160 bytes/);
    expect(() => hashLeaf(new Uint8Array(161))).toThrow(/160 bytes/);
    expect(() => hashLeaf(new Uint8Array(32))).toThrow(/160 bytes/);
    expect(() => buildTreeFromChunks([new Uint8Array(160), new Uint8Array(0)])).toThrow(/160 bytes/);
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
    expect(t.chunkCount).toBe(7);
    expect(getProof(t, 6)).toEqual([h45, h0123]);
    expect(getProof(t, 5)).toEqual([l[4], h6, h0123]);
    expect(expectedProofLength(6, 7)).toBe(2);
    expect(expectedProofLength(5, 7)).toBe(3);
  });

  it("expectedProofLength matches getProof for every index, 1..40 leaves", () => {
    for (let n = 1; n <= 40; n++) {
      const t = buildTree(leaves(n));
      for (let i = 0; i < n; i++) expect(getProof(t, i).length).toBe(expectedProofLength(i, n));
    }
    expect(expectedProofLength(0, 1)).toBe(0);
    expect(() => expectedProofLength(3, 3)).toThrow(/out of range/);
    expect(() => expectedProofLength(0, 0)).toThrow();
  });

  it("every index verifies for 1..20 leaves and every corruption fails", () => {
    for (let n = 1; n <= 20; n++) {
      const l = leaves(n);
      const t = buildTree(l);
      for (let i = 0; i < n; i++) {
        const proof = getProof(t, i);
        expect(verifyProof({ root: t.root, leaf: l[i]!, index: i, proof, chunkCount: n })).toBe(true);
        expect(computeRootFromProof(l[i]!, i, proof, n)).toBe(t.root);
        // wrong index, wrong leaf, tampered proof, truncated/extended proof, wrong chunk count
        expect(verifyProof({ root: t.root, leaf: l[i]!, index: (i + 1) % n, proof, chunkCount: n })).toBe(n === 1);
        expect(verifyProof({ root: t.root, leaf: leaf(1000 + i), index: i, proof, chunkCount: n })).toBe(false);
        expect(verifyProof({ root: t.root, leaf: l[i]!, index: i, proof: [...proof, leaf(999)], chunkCount: n })).toBe(false);
        if (proof.length > 0) {
          const tampered = [...proof];
          tampered[0] = leaf(999);
          expect(verifyProof({ root: t.root, leaf: l[i]!, index: i, proof: tampered, chunkCount: n })).toBe(false);
          expect(verifyProof({ root: t.root, leaf: l[i]!, index: i, proof: proof.slice(1), chunkCount: n })).toBe(false);
        }
        // A wrong chunk count is caught whenever it changes the proof length for this index.
        if (n > 1 && i < n - 1 && expectedProofLength(i, n - 1) !== proof.length) {
          expect(verifyProof({ root: t.root, leaf: l[i]!, index: i, proof, chunkCount: n - 1 })).toBe(false);
        }
        if (i > 0) expect(verifyProof({ root: t.root, leaf: l[i]!, index: i, proof, chunkCount: i })).toBe(false); // index out of range
      }
    }
  });

  it("the internal-node-as-leaf second preimage now fails", () => {
    const l = leaves(4);
    const t = buildTree(l);
    const internal = hashPair(l[0]!, l[1]!);
    const shortProof = [hashPair(l[2]!, l[3]!)];
    // Attack: present the internal node h(l0,l1) as "leaf 0" with a one-element proof.
    // Shape pinning: a 4-chunk tree needs 2 elements at index 0, so the proof length is rejected.
    expect(expectedProofLength(0, 4)).toBe(2);
    expect(verifyProof({ root: t.root, leaf: internal, index: 0, proof: shortProof, chunkCount: 4 })).toBe(false);
    expect(computeRootFromProof(internal, 0, shortProof, 4)).toBeUndefined();
    // Domain separation: even in a 2-chunk tree the internal node would have to be a leaf hash,
    // i.e. keccak256(0x00 || chunk) for some 160-byte chunk, while it is keccak256(0x01 || ...).
    // The verifier therefore never accepts a lied-about chunkCount for a chunk-backed leaf:
    const chunk = new Uint8Array(160).fill(1);
    expect(hashLeaf(chunk)).not.toBe(keccak256(concat([new Uint8Array([NODE_PREFIX]), chunk])));
    expect(verifyProof({ root: t.root, leaf: hashLeaf(chunk), index: 0, proof: shortProof, chunkCount: 2 })).toBe(false);
  });

  it("rejects empty trees, out-of-range indices and bad chunk counts", () => {
    expect(() => buildTree([])).toThrow();
    const t = buildTree(leaves(3));
    expect(() => getProof(t, 3)).toThrow();
    expect(() => getProof(t, -1)).toThrow();
    expect(() => getProof(t, 1.5)).toThrow();
    expect(verifyProof({ root: t.root, leaf: leaf(0), index: 3, proof: [], chunkCount: 3 })).toBe(false);
    expect(() => verifyProof({ root: t.root, leaf: leaf(0), index: 0, proof: [], chunkCount: 0 })).toThrow();
    expect(() => verifyProof({ root: t.root, leaf: leaf(0), index: 0, proof: [], chunkCount: 1.5 })).toThrow();
  });
});
