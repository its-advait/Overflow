import {
  buildMismatchComplaint,
  buildTree,
  checkMismatch,
  ComplaintNotWarrantedError,
  decryptChunk,
  getProof,
  hashLeaf,
  keyCommitment,
  revealChunkKeys,
  verifyCiphertext,
  verifySample,
} from "@overflow/recourse-crypto";
import { computeOrderId, computeTermsHash, USDC } from "@overflow/schemas";
import { toHex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import type { RecourseListing } from "./datasets.js";
import { BUYER, loadSmallListing, SALT, SELLER, SELLER_SECRET } from "./fixtures.test-util.js";
import { buildOrder, swapIndexFor } from "./terms.js";

const NOW = 1_800_000_000n;
const config = { bondBps: 2000, revealWindowS: 600, challengeWindowS: 120 };
let listing: RecourseListing;
beforeAll(async () => {
  listing = await loadSmallListing();
});

const build = (behavior: "honest" | "swap" | "ghost", swapIndex?: number) =>
  buildOrder({ listing, buyer: BUYER, missionId: "m-1", seller: SELLER.address, sellerSecret: SELLER_SECRET, salt: SALT, nowSeconds: NOW, config: { ...config, swapIndex }, behavior });

describe("buildOrder (SIMULATED Recourse terms)", () => {
  it("honest: terms recompute, ciphertext verifies and every chunk decrypts to the committed plain leaf", () => {
    const { terms, k, cipherChunks, swapIndex } = build("honest");
    expect(swapIndex).toBeNull();
    expect(terms.chunkCount).toBe(48);
    expect(terms.token).toBe(USDC.address);
    expect(terms.amount).toBe(listing.priceAtomic);
    expect(BigInt(terms.bond)).toBe((BigInt(listing.priceAtomic) * 2000n) / 10_000n);
    expect(terms.revealDeadline).toBe((NOW + 600n).toString());
    expect(terms.keyCommitment).toBe(keyCommitment(k));
    expect(terms.rootPlain).toBe(listing.manifest.rootPlain);
    const termsHash = computeTermsHash({
      token: terms.token,
      amountAtomic: terms.amount,
      bondAtomic: terms.bond,
      manifestHash: terms.manifestHash,
      rootPlain: terms.rootPlain,
      rootCipher: terms.rootCipher,
      keyCommitment: terms.keyCommitment,
      revealDeadline: terms.revealDeadline,
      challengeWindow: terms.challengeWindow,
      sourceKey: terms.sourceKey,
      minTimestamp: terms.minTimestamp,
      chunkCount: String(terms.chunkCount),
    });
    expect(terms.termsHash).toBe(termsHash);
    expect(terms.orderId).toBe(computeOrderId({ missionId: "m-1", resourceId: listing.id, buyer: BUYER, seller: SELLER.address, amountAtomic: terms.amount, termsHash, salt: SALT }));
    expect(verifyCiphertext(cipherChunks, terms.rootCipher, terms.chunkCount)).toBe(true);
    for (let i = 0; i < cipherChunks.length; i++) {
      expect(hashLeaf(decryptChunk(cipherChunks[i]!, k, i))).toBe(listing.plainLeaves[i]);
    }
  });

  it("swap: ciphertext still verifies, exactly one chunk mismatches, and a complaint is warranted only there", () => {
    const { terms, k, cipherChunks } = build("swap");
    const expected = swapIndexFor(SALT, 48);
    expect(verifyCiphertext(cipherChunks, terms.rootCipher, terms.chunkCount)).toBe(true);
    expect(terms.rootPlain).toBe(listing.manifest.rootPlain);
    const bad = cipherChunks.map((c, i) => checkMismatch(i, c, k, listing.plainLeaves[i]!).mismatch).flatMap((m, i) => (m ? [i] : []));
    expect(bad).toEqual([expected]);
    expect(cipherChunks[expected]!.length).toBe(160);
    const complaint = buildMismatchComplaint({ index: expected, cipherChunks, plainLeaves: listing.plainLeaves, revealedKey: k, rootCipher: terms.rootCipher, rootPlain: terms.rootPlain });
    expect(complaint.i).toBe(BigInt(expected));
    expect(complaint.cipherChunk).toBe(toHex(cipherChunks[expected]!));
    expect(complaint.plainLeaf).toBe(listing.plainLeaves[expected]);
    const other = (expected + 1) % 48;
    expect(() => buildMismatchComplaint({ index: other, cipherChunks, plainLeaves: listing.plainLeaves, revealedKey: k })).toThrow(ComplaintNotWarrantedError);
    // A pre-funding sample of an unswapped index passes: the swap only shows after the full decrypt.
    const cipherTree = buildTree(cipherChunks.map(hashLeaf));
    const plainTree = buildTree(listing.plainLeaves);
    const [reveal] = revealChunkKeys(k, [other]);
    const verdict = verifySample(cipherChunks[other]!, reveal!.chunkKey, listing.plainLeaves[other]!, {
      index: other,
      cipherProof: getProof(cipherTree, other),
      plainProof: getProof(plainTree, other),
      rootCipher: terms.rootCipher,
      rootPlain: terms.rootPlain,
      chunkCount: 48,
    });
    expect(verdict.ok).toBe(true);
  });

  it("swap index override is honored and the honest order differs only in rootCipher/termsHash/orderId", () => {
    const honest = build("honest");
    const swapped = build("swap", 7);
    expect(swapped.swapIndex).toBe(7);
    expect(swapped.k).toBe(honest.k);
    expect(swapped.terms.rootCipher).not.toBe(honest.terms.rootCipher);
    expect(swapped.terms.keyCommitment).toBe(honest.terms.keyCommitment);
    expect(checkMismatch(7, swapped.cipherChunks[7]!, swapped.k, listing.plainLeaves[7]!).mismatch).toBe(true);
  });
});
