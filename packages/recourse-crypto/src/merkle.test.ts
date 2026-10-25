import { keccak256, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  CHUNK_SIZE,
  expectedProofLength,
  hashLeaf,
  hashNode,
  keyCommitment,
  merkleProof,
  merkleRoot,
  verifyProof,
} from "./index";

// Golden vectors shared with contracts/test/escrow/MerkleLib.t.sol. Chunk i = 160 bytes of value i.
const chunk = (b: number): Hex => toHex(new Uint8Array(CHUNK_SIZE).fill(b));
const leaves = (n: number): Hex[] => Array.from({ length: n }, (_, i) => hashLeaf(chunk(i)));

const ROOTS: Record<number, Hex> = {
  1: "0x01334b96c6f1baee2e4eea04c858b9f670100aac3847505fa578f145b2cfb669",
  2: "0x35816244a3b343235ece3093efe230765f217779788eae17382d79e0275a0a9f",
  3: "0x41183bd7bd4cd42181a0e17c2750a530bc699570381715729f238718ce69fd35",
  4: "0x7b4dfbe77f6de75e64a4844facba6bc69464bc2df3edf2ed8336dcc16ea6b3bf",
  5: "0xc868e8c578f523e327492fff75bcd28af5755fdfc5d284c604e5a2b379f96698",
};
const LEAF_1: Hex = "0x72d1821b1b923be327bba73e1c2eecd8bcf0cc0584d9e7a81ab4090dd56544a8";
const PROOF_5_0: Hex[] = [
  LEAF_1,
  "0xd487f67090ce8d4c22b16310c7fcf7ae0a0c0da15b2411aa449038e107eef490",
  "0x3e551ca2641a5d487c28194e13249c293551a561c1f6da270d9e06a5e23423a9",
];

// expectedProofLength(i, n) for n = 1..8 (row n-1, column i); mirrors MerkleLib.t.sol.
const LENGTHS = [
  [0],
  [1, 1],
  [2, 2, 1],
  [2, 2, 2, 2],
  [3, 3, 3, 3, 1],
  [3, 3, 3, 3, 2, 2],
  [3, 3, 3, 3, 3, 3, 2],
  [3, 3, 3, 3, 3, 3, 3, 3],
];

describe("merkle golden vectors (match MerkleLib.sol)", () => {
  it("roots for n = 1..5", () => {
    for (const [n, root] of Object.entries(ROOTS)) expect(merkleRoot(leaves(Number(n)))).toBe(root);
    expect(hashLeaf(chunk(1))).toBe(LEAF_1);
    expect(hashNode(hashLeaf(chunk(0)), LEAF_1)).toBe(ROOTS[2]);
  });

  it("proof for leaf 0 and leaf 4 of a 5-leaf tree", () => {
    const l = leaves(5);
    expect(merkleProof(l, 0)).toEqual(PROOF_5_0);
    expect(merkleProof(l, 4)).toEqual([ROOTS[4]]);
    expect(verifyProof(PROOF_5_0, ROOTS[5] as Hex, l[0] as Hex, 0, 5)).toBe(true);
    expect(verifyProof([ROOTS[4] as Hex], ROOTS[5] as Hex, l[4] as Hex, 4, 5)).toBe(true);
  });

  it("expectedProofLength table", () => {
    LENGTHS.forEach((row, k) => {
      const n = k + 1;
      row.forEach((len, i) => expect(expectedProofLength(i, n)).toBe(len));
    });
    expect(() => expectedProofLength(3, 3)).toThrow();
    expect(() => expectedProofLength(0, 0)).toThrow();
  });
});

describe("merkle properties", () => {
  it("round-trips every index for n = 1..9 and rejects wrong leaf or index", () => {
    for (let n = 1; n <= 9; n++) {
      const l = leaves(n);
      const root = merkleRoot(l);
      for (let i = 0; i < n; i++) {
        const p = merkleProof(l, i);
        expect(p.length).toBe(expectedProofLength(i, n));
        expect(verifyProof(p, root, l[i] as Hex, i, n)).toBe(true);
        if (n > 1) {
          expect(verifyProof(p, root, l[(i + 1) % n] as Hex, i, n)).toBe(false);
          expect(verifyProof(p, root, l[i] as Hex, (i + 1) % n, n)).toBe(false);
        }
      }
    }
  });

  it("rejects an internal node presented as a leaf (domain separation + exact length)", () => {
    const l = leaves(4);
    const root = merkleRoot(l);
    const node01 = hashNode(l[0] as Hex, l[1] as Hex);
    const node23 = hashNode(l[2] as Hex, l[3] as Hex);
    expect(hashNode(node01, node23)).toBe(root);
    expect(verifyProof([node23], root, node01, 0, 4)).toBe(false); // too short
    expect(verifyProof([node23, "0x" + "00".repeat(32)] as Hex[], root, node01, 0, 4)).toBe(false);
    expect(hashLeaf((l[0] as string).concat((l[1] as string).slice(2)) as Hex)).not.toBe(node01);
  });

  it("rejects proofs with extra or missing elements", () => {
    const l = leaves(4);
    const root = merkleRoot(l);
    const p = merkleProof(l, 0);
    expect(verifyProof(p.slice(0, 1), root, l[0] as Hex, 0, 4)).toBe(false);
    expect(verifyProof([...p, p[0] as Hex], root, l[0] as Hex, 0, 4)).toBe(false);
  });

  it("domain-separates leaves from nodes and plain keccak", () => {
    const c = chunk(7);
    expect(hashLeaf(c)).not.toBe(keccak256(c));
    const a = keccak256("0x61");
    const b = keccak256("0x62");
    expect(hashNode(a, b)).not.toBe(hashNode(b, a));
    expect(hashNode(a, b)).not.toBe(keccak256(`0x${a.slice(2)}${b.slice(2)}`));
  });

  it("keyCommitment is keccak256 of the bytes32 key", () => {
    const key = keccak256("0x6b6579");
    expect(keyCommitment(key)).toBe(keccak256(key));
    expect(() => keyCommitment("0x1234")).toThrow();
  });
});
