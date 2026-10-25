import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { keccak256, recoverAddress } from "viem";
import { describe, expect, it } from "vitest";
import { toHexString } from "./bytes";
import { checkMismatch } from "./complaint";
import { chunkKey, decryptChunk, keyCommitment, keystream, perBuyerKey } from "./keys";
import { buildTree, hashLeaf, verifyProof } from "./merkle";
import { parseChunk, recoverRecordSigner } from "./record";
import { pickSampleIndices } from "./sample";
import { FIXTURE_RELATIVE_PATH, VECTORS_RELATIVE_PATH, generateGoldenVectors, parseGoldenVectors, serializeGoldenVectors } from "./vectors";

const packageRoot = resolve(import.meta.dirname, "..");
const vectorsPath = resolve(packageRoot, VECTORS_RELATIVE_PATH);
const fixturePath = resolve(packageRoot, "../..", FIXTURE_RELATIVE_PATH);

describe("golden vectors", () => {
  it("regenerating gives byte-identical JSON, and the Solidity fixture is an exact copy", async () => {
    const onDisk = await readFile(vectorsPath, "utf8");
    const regenerated = serializeGoldenVectors(await generateGoldenVectors());
    expect(regenerated).toBe(onDisk);
    expect(await readFile(fixturePath, "utf8")).toBe(onDisk);
  });

  it("every value in the file is reproducible from the primitives", async () => {
    const v = parseGoldenVectors(await readFile(vectorsPath, "utf8"));
    expect(v.leafCount).toBe(7);
    expect(v.chunks.length).toBe(7);

    const k = perBuyerKey(v.sellerSecret, v.orderId, v.buyer);
    expect(k).toBe(v.perBuyerKey);
    expect(keyCommitment(k)).toBe(v.keyCommitment);

    const plainTree = buildTree(v.chunks.map((c) => c.plainLeaf));
    const cipherTree = buildTree(v.chunks.map((c) => c.cipherLeaf));
    expect(plainTree.root).toBe(v.rootPlain);
    expect(cipherTree.root).toBe(v.rootCipher);

    for (const c of v.chunks) {
      const parsed = parseChunk(c.plain);
      expect(parsed.row).toBe(c.row);
      expect(parsed.timestamp.toString()).toBe(c.timestamp);
      expect(`0x${c.plain.slice(2, 2 + 95 * 2)}`).toBe(c.payload);
      expect(`0x${c.plain.slice(2 + 95 * 2)}`).toBe(c.signature);
      expect(await recoverAddress({ hash: keccak256(c.payload), signature: c.signature })).toBe(v.sourceSigner.address);
      expect(chunkKey(k, c.index)).toBe(c.chunkKey);
      expect(toHexString(keystream(c.chunkKey))).toBe(c.keystream);
      expect(hashLeaf(c.plain)).toBe(c.plainLeaf);
      expect(hashLeaf(c.cipher)).toBe(c.cipherLeaf);
      expect(hashLeaf(decryptChunk(c.cipher, k, c.index))).toBe(c.plainLeaf);
      expect(verifyProof({ root: v.rootPlain, leaf: c.plainLeaf, index: c.index, proof: c.plainProof, leafCount: 7 })).toBe(true);
      expect(verifyProof({ root: v.rootCipher, leaf: c.cipherLeaf, index: c.index, proof: c.cipherProof, leafCount: 7 })).toBe(true);
    }
    expect(v.chunks[6]!.plainProof.length).toBe(2); // odd-level carry
    expect(pickSampleIndices(7, v.sample.count, v.sample.randomBytes)).toEqual(v.sample.indices);
    for (const r of v.sample.revealedChunkKeys) expect(r.chunkKey).toBe(chunkKey(k, r.index));
  });

  it("the swapped chunk vector is a valid complainMismatch", async () => {
    const v = parseGoldenVectors(await readFile(vectorsPath, "utf8"));
    const s = v.swappedChunk;
    const a = s.complainMismatch;
    expect(a.i).toBe(String(s.index));
    expect(a.cipherChunk).toBe(s.cipher);
    expect(a.plainLeaf).toBe(v.chunks[s.index]!.plainLeaf);
    expect(verifyProof({ root: s.rootCipher, leaf: hashLeaf(a.cipherChunk), index: s.index, proof: a.cipherProof, leafCount: 7 })).toBe(true);
    expect(verifyProof({ root: v.rootPlain, leaf: a.plainLeaf, index: s.index, proof: a.plainProof, leafCount: 7 })).toBe(true);
    const check = checkMismatch(s.index, a.cipherChunk, v.perBuyerKey, a.plainLeaf);
    expect(check.mismatch).toBe(true);
    expect(check.derivedLeaf).toBe(s.derivedPlainLeaf);
    expect(s.derivedPlainLeaf).toBe(hashLeaf(s.plain));
  });

  it("the wrong-source vector is a valid complainPromise", async () => {
    const v = parseGoldenVectors(await readFile(vectorsPath, "utf8"));
    const w = v.wrongSourceRecord;
    expect(w.complainPromise.i).toBe(String(w.index));
    expect(w.complainPromise.plainChunk).toBe(w.plain);
    expect(verifyProof({ root: w.rootPlain, leaf: hashLeaf(w.plain), index: w.index, proof: w.complainPromise.plainProof, leafCount: 7 })).toBe(true);
    const signer = await recoverRecordSigner(w.plain);
    expect(signer).toBe(w.recoveredSigner);
    expect(signer).toBe(v.wrongSigner.address);
    expect(signer).not.toBe(w.promise.sourceKey);
    // Same payload as the honest record 5; only the signature differs.
    expect(w.plain.slice(0, 2 + 95 * 2)).toBe(v.chunks[w.index]!.plain.slice(0, 2 + 95 * 2));
  });
});
