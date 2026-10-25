import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chunkKey, hashLeaf, parseGoldenVectors, toBytes, type GoldenVectors } from "@overflow/recourse-crypto";
import { describe, expect, it } from "vitest";
import { buildMismatchEvidence, ComplaintNotWarrantedError, drawSample, findFirstMismatch, judgeSample, RULE_JUDGE, verifySampleRows } from "./evidence.js";

// The golden vectors (packages/recourse-crypto/test/vectors.json): 7 SIMULATED chunks, a sample at [3, 0, 4] and a
// seller who swapped chunk 3's ciphertext. The same bytes the contracts' fixture test checks.
const vectors: GoldenVectors = parseGoldenVectors(readFileSync(resolve(import.meta.dirname, "../../../../packages/recourse-crypto/test/vectors.json"), "utf8"));
const cipher = vectors.chunks.map((c) => toBytes(c.cipher));
const plainLeaves = vectors.chunks.map((c) => c.plainLeaf);
const k = vectors.perBuyerKey;
const chunkCount = vectors.chunkCount;
const sourceKey = vectors.sourceSigner.address;

describe("recourse evidence on the golden vectors", () => {
  it("re-derives the sample and verifies every honest row, decoding the record", () => {
    const indices = drawSample(vectors.sample.count, chunkCount, vectors.sample.randomBytes);
    expect(indices).toEqual(vectors.sample.indices);
    const rows = verifySampleRows({
      cipherChunks: cipher,
      plainLeaves,
      rootCipher: vectors.rootCipher,
      rootPlain: vectors.rootPlain,
      chunkCount,
      revealed: indices.map((index) => ({ index, chunkKey: chunkKey(k, index) })),
    });
    expect(rows.map((r) => [r.index, r.verified])).toEqual(indices.map((i) => [i, "ok"]));
    for (const r of rows) {
      expect(r.row).toBeTypeOf("string");
      expect(r.timestamp).toMatch(/^\d+$/);
      expect(hashLeaf(r.plainChunk!)).toBe(r.plainLeaf);
    }
  });

  it("the rule judge buys an honest sample and names its rule; a bad proof is a skip", async () => {
    const rows = verifySampleRows({
      cipherChunks: cipher,
      plainLeaves,
      rootCipher: vectors.rootCipher,
      rootPlain: vectors.rootPlain,
      chunkCount,
      revealed: vectors.sample.indices.map((index) => ({ index, chunkKey: chunkKey(k, index) })),
    });
    const header = "month,state,brand,units,simulated";
    const columns = rows[0]!.row!.split(",").length;
    const judged = await judgeSample({ rows, header: Array.from({ length: columns }, (_, i) => `c${i}`).join(","), sourceKey, minTimestamp: 0n });
    expect(judged.judge).toBe(RULE_JUDGE);
    expect(judged.verdict).toBe("buy");
    // Wrong column count: skip, naming the chunk.
    const wrongShape = await judgeSample({ rows, header: `${header},extra,extra`, sourceKey, minTimestamp: 0n });
    expect(wrongShape.verdict).toBe("skip");
    // A row served with the wrong chunk key: decrypt-mismatch, skip.
    const badRows = verifySampleRows({
      cipherChunks: cipher,
      plainLeaves,
      rootCipher: vectors.rootCipher,
      rootPlain: vectors.rootPlain,
      chunkCount,
      revealed: [{ index: 3, chunkKey: chunkKey(k, 4) }],
    });
    expect(badRows[0]!.verified).toBe("decrypt-mismatch");
    expect((await judgeSample({ rows: badRows, header, sourceKey, minTimestamp: 0n })).verdict).toBe("skip");
  });

  it("finds the swapped chunk after the reveal and builds a complaint with both proofs verified", () => {
    const swapped = vectors.swappedChunk;
    const served = cipher.map((c, i) => (i === swapped.index ? toBytes(swapped.cipher) : c));
    expect(findFirstMismatch(cipher, plainLeaves, k)).toEqual({ index: undefined, checked: chunkCount });
    expect(findFirstMismatch(served, plainLeaves, k)).toEqual({ index: swapped.index, checked: swapped.index + 1 });
    const evidence = buildMismatchEvidence({ index: swapped.index, cipherChunks: served, plainLeaves, revealedKey: k, rootCipher: swapped.rootCipher, rootPlain: vectors.rootPlain, chunkCount });
    expect(evidence).toMatchObject({ kind: "mismatch", chunkIndex: swapped.index, cipherProofVerified: true, plainProofVerified: true, cheatVerified: true });
    expect(evidence.chunk).toBe(swapped.complainMismatch.cipherChunk);
    expect(evidence.cipherProof).toEqual(swapped.complainMismatch.cipherProof);
    expect(evidence.plainProof).toEqual(swapped.complainMismatch.plainProof);
    expect(evidence.plainLeaf).toBe(swapped.complainMismatch.plainLeaf);
    expect(evidence.derivedLeaf).not.toBe(evidence.plainLeaf);
  });

  it("refuses to build a complaint about an honest chunk", () => {
    expect(() => buildMismatchEvidence({ index: 0, cipherChunks: cipher, plainLeaves, revealedKey: k, rootCipher: vectors.rootCipher, rootPlain: vectors.rootPlain, chunkCount })).toThrow(ComplaintNotWarrantedError);
  });
});
