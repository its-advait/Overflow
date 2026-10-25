import { keccak256, stringToBytes, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { toHexString } from "./bytes";
import { commitDataset } from "./commit";
import { checkMismatch } from "./complaint";
import { chunkKey, decryptChunk, encryptChunk, keyCommitment, keystreamBlock, perBuyerKey } from "./keys";
import { buildTree, expectedProofLength, getProof, hashLeaf, hashPair, verifyProof } from "./merkle";
import { CHUNK_BYTES } from "./record";

// Golden vectors pinned on the Solidity side: contracts/test/escrow/RecourseCrypto.t.sol and
// contracts/test/escrow/MerkleLib.t.sol. Chunk i = 160 bytes of value i. Any drift between this package and
// RecourseCrypto.sol / MerkleLib.sol fails here and in forge.
const KEY = keccak256(stringToBytes("overflow.golden.key"));
const chunk = (b: number): Hex => toHex(new Uint8Array(CHUNK_BYTES).fill(b));
const plain = [0, 1, 2, 3, 4].map(chunk);
const leaves = (n: number): Hex[] => Array.from({ length: n }, (_, i) => hashLeaf(chunk(i)));
const hex = (b: Uint8Array): Hex => toHexString(b);

const V = {
  KEY: "0x7821e83d3d34740e94104147499f90f473b3c525dffeb768d2cb03021ba69f1c",
  K_0: "0x0e8bdfc41c4e57b98b1162b5a3e6ccd13542c41945893be60b01b9ca28d735e2",
  K_2: "0xffb85269e2a5e166b761e710605369fe02aa8321734697e4b8ee0a55ba31de8f",
  KS_0_0: "0x537a0d443f3dcb55490250890b4fab7903389a09f2797b00ee02d7277b4914f6",
  KS_0_4: "0xb6722df19f1c806db82af3fd7966eb2e8882c01f06768814c12cc4e96150d5ef",
  KEY_COMMITMENT: "0xc6ef49f0220a08b0ff4bd81c6ca6f40627f458d9fe7d2216bb86e2ddad5ff75c",
  ROOT_PLAIN: "0xc868e8c578f523e327492fff75bcd28af5755fdfc5d284c604e5a2b379f96698",
  ROOT_CIPHER: "0x52ef6ce6cf44eb9574b9c2cc8ab71078a0ddb6c9939fc9fccccee581eebfa6e7",
  CIPHER_LEAF_0: "0x68c431737433b99e5f795d359831f8a900048fb4a706655cfd5b01d4c772e185",
  DERIVED: "0x29ea90fe0aa3eb42a3ec85afc9666785d44c522ac8383e9b1d994161f0c8f233",
  C_0: "0x537a0d443f3dcb55490250890b4fab7903389a09f2797b00ee02d7277b4914f6a812229f0e5914a4871c5be13a148b4b6bc44b2fb45c97bdf0fe455209001ef80b0f606f570deefc4db93bb777a38dd1ce3f5f7330f47d62888087f46297f1f46ebcb28f5d03492ba72b93ebf1e0c87f0d7a316cb017893b4634507b91df356bb6722df19f1c806db82af3fd7966eb2e8882c01f06768814c12cc4e96150d5ef",
  C_2: "0x666b7e5683e24c7edcc69a0b418fd5bcf9bec77d3facfba8f461974882c1c11f7115855335b68c982f158274b9e43119df36a19b75653bbffff7632f259f00ec5a6e9406aeece8346f7f574a098658342bafe7440ac317e55779449e7fc3c3ea1df4efb268c4b3d81fe2817ace1f2fedda6975dab01ade620e1a275b4f1377804863e74851b40a462aa4c1e8e05f2fd2c4cb5236c897ca929ae4f7e8b27f9818",
} as const;

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

describe("keystream golden vectors (match RecourseCrypto.sol)", () => {
  it("keys and keystream", () => {
    expect(KEY).toBe(V.KEY);
    expect(chunkKey(KEY, 0)).toBe(V.K_0);
    expect(chunkKey(KEY, 2)).toBe(V.K_2);
    expect(keystreamBlock(V.K_0, 0)).toBe(V.KS_0_0);
    expect(keystreamBlock(V.K_0, 4)).toBe(V.KS_0_4);
    expect(perBuyerKey(keccak256(stringToBytes("secret")), keccak256(stringToBytes("order")), "0x1111111111111111111111111111111111111111")).toBe(V.DERIVED);
    expect(keyCommitment(KEY)).toBe(V.KEY_COMMITMENT);
  });

  it("ciphertext and roots", () => {
    expect(hex(encryptChunk(plain[0] as Hex, KEY, 0))).toBe(V.C_0);
    expect(hex(encryptChunk(plain[2] as Hex, KEY, 2))).toBe(V.C_2);
    expect(hex(decryptChunk(V.C_0, KEY, 0))).toBe(plain[0]);
    expect(hex(decryptChunk(V.C_2, KEY, 2))).toBe(plain[2]);
    expect(buildTree(plain.map(hashLeaf)).root).toBe(V.ROOT_PLAIN);
    const cipherLeaves = plain.map((p, i) => hashLeaf(encryptChunk(p, KEY, i)));
    expect(cipherLeaves[0]).toBe(V.CIPHER_LEAF_0);
    expect(buildTree(cipherLeaves).root).toBe(V.ROOT_CIPHER);
  });

  it("a swapped ciphertext chunk proves under both roots and fails the mismatch check (EscrowMismatch.t.sol)", () => {
    const honestCipherLeaves = plain.map((p, i) => hashLeaf(encryptChunk(p, KEY, i)));
    const junkCipher = encryptChunk(chunk(0xee), KEY, 2);
    const cheatLeaves = [...honestCipherLeaves];
    cheatLeaves[2] = hashLeaf(junkCipher);
    const cheatTree = buildTree(cheatLeaves);
    const plainTree = buildTree(plain.map(hashLeaf));
    expect(verifyProof({ root: cheatTree.root, leaf: hashLeaf(junkCipher), index: 2, proof: getProof(cheatTree, 2), chunkCount: 5 })).toBe(true);
    expect(verifyProof({ root: plainTree.root, leaf: hashLeaf(plain[2] as Hex), index: 2, proof: getProof(plainTree, 2), chunkCount: 5 })).toBe(true);
    expect(checkMismatch(2, junkCipher, KEY, hashLeaf(plain[2] as Hex)).mismatch).toBe(true);
    expect(checkMismatch(1, encryptChunk(plain[1] as Hex, KEY, 1), KEY, hashLeaf(plain[1] as Hex)).mismatch).toBe(false);
  });

  it("commitDataset reproduces the roots for a bytes32 key nonce", () => {
    // perBuyerKey(secret, nonce, buyer) is the only key derivation; the nonce is any bytes32 the seller binds the order to.
    const c = commitDataset({ plainChunks: plain, sellerSecret: keccak256(stringToBytes("secret")), orderId: keccak256(stringToBytes("order")), buyer: "0x1111111111111111111111111111111111111111" });
    expect(c.perBuyerKey).toBe(V.DERIVED);
    expect(c.rootPlain).toBe(V.ROOT_PLAIN);
    expect(c.chunkCount).toBe(5);
  });
});

describe("merkle golden vectors (match MerkleLib.sol)", () => {
  it("roots for n = 1..5", () => {
    for (const [n, root] of Object.entries(ROOTS)) expect(buildTree(leaves(Number(n))).root).toBe(root);
    expect(hashLeaf(chunk(1))).toBe(LEAF_1);
    expect(hashPair(hashLeaf(chunk(0)), LEAF_1)).toBe(ROOTS[2]);
  });

  it("proof for leaf 0 and leaf 4 of a 5-leaf tree", () => {
    const t = buildTree(leaves(5));
    expect(getProof(t, 0)).toEqual(PROOF_5_0);
    expect(getProof(t, 4)).toEqual([ROOTS[4]]);
    expect(verifyProof({ root: ROOTS[5] as Hex, leaf: leaves(5)[0] as Hex, index: 0, proof: PROOF_5_0, chunkCount: 5 })).toBe(true);
    expect(verifyProof({ root: ROOTS[5] as Hex, leaf: leaves(5)[4] as Hex, index: 4, proof: [ROOTS[4] as Hex], chunkCount: 5 })).toBe(true);
  });

  it("expectedProofLength table", () => {
    LENGTHS.forEach((row, k) => {
      const n = k + 1;
      row.forEach((len, i) => expect(expectedProofLength(i, n)).toBe(len));
    });
    expect(() => expectedProofLength(3, 3)).toThrow();
    expect(() => expectedProofLength(0, 0)).toThrow();
  });

  it("round-trips every index for n = 1..9 and rejects a wrong leaf, index or proof length", () => {
    for (let n = 1; n <= 9; n++) {
      const l = leaves(n);
      const t = buildTree(l);
      for (let i = 0; i < n; i++) {
        const p = getProof(t, i);
        expect(p.length).toBe(expectedProofLength(i, n));
        expect(verifyProof({ root: t.root, leaf: l[i] as Hex, index: i, proof: p, chunkCount: n })).toBe(true);
        if (n > 1) {
          expect(verifyProof({ root: t.root, leaf: l[(i + 1) % n] as Hex, index: i, proof: p, chunkCount: n })).toBe(false);
          expect(verifyProof({ root: t.root, leaf: l[i] as Hex, index: (i + 1) % n, proof: p, chunkCount: n })).toBe(false);
          expect(verifyProof({ root: t.root, leaf: l[i] as Hex, index: i, proof: [...p, p[0] as Hex], chunkCount: n })).toBe(false);
        }
      }
    }
  });
});
