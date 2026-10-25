import { describe, expect, it } from "vitest";
import { commitDataset } from "./commit";
import { chunkKey } from "./keys";
import { getProof } from "./merkle";
import { buildRecordChunk } from "./record";
import { pickSampleIndices, revealChunkKeys, verifySample } from "./sample";
import { simulatedBytes32 } from "./vectors";

const sellerSecret = simulatedBytes32("s-secret");
const orderId = simulatedBytes32("s-order");
const buyer = "0x595b4704F8d39F861B253CeF5Bd02B3B3fE57d34" as const;
const sourceKey = simulatedBytes32("s-source");

async function dataset(n: number) {
  const plainChunks = await Promise.all(Array.from({ length: n }, (_, i) => buildRecordChunk({ timestamp: BigInt(1735689600 + i), row: `row-${i}` }, sourceKey)));
  return commitDataset({ plainChunks, sellerSecret, orderId, buyer });
}

describe("pickSampleIndices", () => {
  it("returns unique in-range indices, deterministically", () => {
    const r = simulatedBytes32("rand");
    const a = pickSampleIndices(100, 20, r);
    expect(a.length).toBe(20);
    expect(new Set(a).size).toBe(20);
    expect(a.every((i) => Number.isInteger(i) && i >= 0 && i < 100)).toBe(true);
    expect(pickSampleIndices(100, 20, r)).toEqual(a);
    expect(pickSampleIndices(100, 20, simulatedBytes32("rand2"))).not.toEqual(a);
  });

  it("can cover the whole set and rejects count > n", () => {
    expect([...pickSampleIndices(7, 7, simulatedBytes32("r"))].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(pickSampleIndices(7, 0, simulatedBytes32("r"))).toEqual([]);
    expect(() => pickSampleIndices(7, 8, simulatedBytes32("r"))).toThrow();
    expect(() => pickSampleIndices(0, 0, simulatedBytes32("r"))).toThrow();
    expect(() => pickSampleIndices(7, 1, new Uint8Array(0))).toThrow();
  });
});

describe("verifySample", () => {
  it("accepts an honest sample using only the revealed chunk keys", async () => {
    const d = await dataset(7);
    const indices = pickSampleIndices(d.leafCount, 3, simulatedBytes32("rand"));
    for (const { index, chunkKey: ck } of revealChunkKeys(d.perBuyerKey, indices)) {
      expect(ck).toBe(chunkKey(d.perBuyerKey, index));
      const verdict = verifySample(d.cipherChunks[index]!, ck, d.plainLeaves[index]!, {
        index,
        cipherProof: getProof(d.cipherTree, index),
        plainProof: getProof(d.plainTree, index),
        rootCipher: d.rootCipher,
        rootPlain: d.rootPlain,
        leafCount: d.leafCount,
      });
      expect(verdict.ok).toBe(true);
      if (verdict.ok) expect(verdict.plainChunk).toEqual(d.plainChunks[index]);
    }
  });

  it("rejects a wrong chunk key, a swapped chunk and bad proofs with distinct reasons", async () => {
    const honest = await dataset(7);
    const index = 6; // the odd-level leaf
    const proofs = {
      index,
      cipherProof: getProof(honest.cipherTree, index),
      plainProof: getProof(honest.plainTree, index),
      rootCipher: honest.rootCipher,
      rootPlain: honest.rootPlain,
      leafCount: honest.leafCount,
    };
    const ck = chunkKey(honest.perBuyerKey, index);

    expect(verifySample(honest.cipherChunks[index]!, chunkKey(honest.perBuyerKey, 5), honest.plainLeaves[index]!, proofs)).toMatchObject({ ok: false, reason: "decrypt-mismatch" });

    // Seller swapped record 6 after committing rootPlain: the ciphertext tree is the swapped one.
    const swappedPlain = await buildRecordChunk({ timestamp: 1735689606n, row: "row-6-swapped" }, sourceKey);
    const swapped = commitDataset({ plainChunks: honest.plainChunks.map((c, i) => (i === index ? swappedPlain : c)), sellerSecret, orderId, buyer });
    expect(
      verifySample(swapped.cipherChunks[index]!, ck, honest.plainLeaves[index]!, { ...proofs, rootCipher: swapped.rootCipher, cipherProof: getProof(swapped.cipherTree, index) }),
    ).toMatchObject({ ok: false, reason: "decrypt-mismatch" });

    expect(verifySample(swapped.cipherChunks[index]!, ck, honest.plainLeaves[index]!, proofs)).toMatchObject({ ok: false, reason: "cipher-proof" });
    expect(verifySample(honest.cipherChunks[index]!, ck, honest.plainLeaves[5]!, proofs)).toMatchObject({ ok: false, reason: "plain-proof" });
  });
});
