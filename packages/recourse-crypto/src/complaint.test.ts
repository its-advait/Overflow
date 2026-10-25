import { privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ComplaintNotWarrantedError, buildMismatchComplaint, buildPromiseComplaint, checkMismatch } from "./complaint";
import { commitDataset, verifyCiphertext, verifyPlainLeaves } from "./commit";
import { decryptDataset } from "./keys";
import { hashLeaf, verifyProof } from "./merkle";
import { buildRecordChunk, recoverRecordSigner } from "./record";
import { simulatedBytes32 } from "./vectors";

const sellerSecret = simulatedBytes32("c-secret");
const orderId = simulatedBytes32("c-order");
const buyer = "0x595b4704F8d39F861B253CeF5Bd02B3B3fE57d34" as const;
const sourceKey = simulatedBytes32("c-source");
const sourceAddress = privateKeyToAddress(sourceKey);
const impostorKey = simulatedBytes32("c-impostor");

async function honestDataset(n = 7) {
  const plainChunks = await Promise.all(Array.from({ length: n }, (_, i) => buildRecordChunk({ timestamp: BigInt(1735689600 + i), row: `row-${i}` }, sourceKey)));
  return commitDataset({ plainChunks, sellerSecret, orderId, buyer });
}

describe("buildMismatchComplaint", () => {
  it("detects a swapped chunk and returns complainMismatch arguments that verify", async () => {
    const honest = await honestDataset();
    const index = 6;
    const swappedPlain = await buildRecordChunk({ timestamp: 1735689606n, row: "row-6-swapped" }, sourceKey);
    const swapped = commitDataset({ plainChunks: honest.plainChunks.map((c, i) => (i === index ? swappedPlain : c)), sellerSecret, orderId, buyer });

    // Buyer's pre-funding checks pass against what the seller committed.
    expect(verifyCiphertext(swapped.cipherChunks, swapped.rootCipher, 7)).toBe(true);
    expect(verifyPlainLeaves(honest.plainLeaves, honest.rootPlain, 7)).toBe(true);

    const args = buildMismatchComplaint({
      index,
      cipherChunks: swapped.cipherChunks,
      plainLeaves: honest.plainLeaves,
      revealedKey: honest.perBuyerKey,
      rootCipher: swapped.rootCipher,
      rootPlain: honest.rootPlain,
    });
    expect(Object.keys(args)).toEqual(["i", "cipherChunk", "cipherProof", "plainLeaf", "plainProof"]);
    expect(args.i).toBe(6n);
    expect(args.plainLeaf).toBe(honest.plainLeaves[index]);
    expect(args.cipherProof.length).toBe(2); // odd-level leaf
    // What the contract does with them:
    expect(verifyProof({ root: swapped.rootCipher, leaf: hashLeaf(args.cipherChunk), index, proof: args.cipherProof, chunkCount: 7 })).toBe(true);
    expect(verifyProof({ root: honest.rootPlain, leaf: args.plainLeaf, index, proof: args.plainProof, chunkCount: 7 })).toBe(true);
    expect(args.cipherProof.length).toBe(args.plainProof.length);
    const check = checkMismatch(index, args.cipherChunk, honest.perBuyerKey, args.plainLeaf);
    expect(check.mismatch).toBe(true);
    expect(check.derivedLeaf).toBe(hashLeaf(swappedPlain));
  });

  it("refuses to complain about an honest delivery", async () => {
    const honest = await honestDataset();
    expect(() =>
      buildMismatchComplaint({ index: 2, cipherChunks: honest.cipherChunks, plainLeaves: honest.plainLeaves, revealedKey: honest.perBuyerKey }),
    ).toThrow(ComplaintNotWarrantedError);
    expect(() =>
      buildMismatchComplaint({ index: 2, cipherChunks: honest.cipherChunks, plainLeaves: honest.plainLeaves, revealedKey: honest.perBuyerKey, rootCipher: simulatedBytes32("nope") }),
    ).toThrow(/rootCipher/);
    expect(() => buildMismatchComplaint({ index: 9, cipherChunks: honest.cipherChunks, plainLeaves: honest.plainLeaves, revealedKey: honest.perBuyerKey })).toThrow(/out of range/);
  });
});

describe("buildPromiseComplaint", () => {
  it("detects a record signed by the wrong source and returns complainPromise arguments", async () => {
    const honest = await honestDataset();
    const index = 4;
    const impostor = await buildRecordChunk({ timestamp: 1735689604n, row: "row-4" }, impostorKey);
    const plainChunks = honest.plainChunks.map((c, i) => (i === index ? impostor : c));
    const delivered = commitDataset({ plainChunks, sellerSecret, orderId, buyer });
    // After the reveal the buyer decrypts everything, then checks promises.
    const decrypted = decryptDataset(delivered.cipherChunks, delivered.perBuyerKey);
    expect(decrypted).toEqual(plainChunks);

    const result = await buildPromiseComplaint({ index, plainChunks: decrypted, sourceKey: sourceAddress, minTimestamp: 1735689600n, rootPlain: delivered.rootPlain });
    const { verdict, ...args } = result;
    expect(Object.keys(args)).toEqual(["i", "plainChunk", "plainProof"]);
    expect(args.i).toBe(4n);
    expect(verdict).toMatchObject({ ok: false, reason: "wrong-source", signer: privateKeyToAddress(impostorKey) });
    expect(verifyProof({ root: delivered.rootPlain, leaf: hashLeaf(args.plainChunk), index, proof: args.plainProof, chunkCount: 7 })).toBe(true);
    expect(await recoverRecordSigner(args.plainChunk)).not.toBe(sourceAddress);
  });

  it("detects a stale timestamp", async () => {
    const honest = await honestDataset();
    const result = await buildPromiseComplaint({ index: 0, plainChunks: honest.plainChunks, sourceKey: sourceAddress, minTimestamp: 1735689601n });
    expect(result.verdict).toMatchObject({ ok: false, reason: "stale-timestamp" });
  });

  it("refuses to complain about a record that honors the promise", async () => {
    const honest = await honestDataset();
    await expect(buildPromiseComplaint({ index: 1, plainChunks: honest.plainChunks, sourceKey: sourceAddress, minTimestamp: 1735689600n })).rejects.toThrow(
      ComplaintNotWarrantedError,
    );
  });
});
