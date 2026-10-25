import { describe, expect, it } from "vitest";
import { GoldenVectorsSchema } from "@overflow/recourse-crypto";
import vectorsJson from "@overflow/recourse-crypto/vectors.json";
import type { Hex } from "@overflow/schemas";
import * as fx from "../mocks/fixtures";
import { checkProof, rederiveIndices, revealedKeyMatches, sameIndices, verifyComplaint, verifySampleRows } from "./evidence";

const V = GoldenVectorsSchema.parse(vectorsJson);
const e = (id: string) => fx.escrows.find((x) => x.id === id)!;

describe("sample re-verification in the browser", () => {
  it("every honest sample row passes both proofs and decrypts to its leaf, with the row text decoded here", () => {
    const sample = fx.sampleByPurchase("pur-merged-national")!;
    const checks = verifySampleRows(sample, e("esc-national"));
    expect(checks.map((c) => [c.index, c.ok, c.cipher.got, c.plain.got])).toEqual([
      [3, true, 3, 3],
      [0, true, 3, 3],
      [4, true, 3, 3],
    ]);
    expect(checks[1]!.row).toBe(V.chunks[0]!.row);
    expect(checks[1]!.timestamp).toBe(V.chunks[0]!.timestamp);
  });
  it("the swap seller's sample (drawn to miss chunk 3) verifies under the swapped rootCipher", () => {
    const sample = fx.sampleByPurchase("pur-ev-swap")!;
    expect(sample.indices).not.toContain(V.swappedChunk.index);
    const checks = verifySampleRows(sample, e("esc-ev-swap"));
    expect(checks.every((c) => c.ok)).toBe(true);
    // The same rows against the honest rootCipher fail the ciphertext proof: chunk 3 changed the tree.
    expect(verifySampleRows(sample, { ...e("esc-ev-swap"), rootCipher: V.rootCipher }).map((c) => c.cipher.ok)).toEqual([false, false, false]);
  });
  it("re-derives the sampled indices from the recorded randomness", () => {
    expect(rederiveIndices(V.sample.randomBytes, 3, 7)).toEqual([3, 0, 4]);
    expect(sameIndices([3, 0, 4], V.sample.indices)).toBe(true);
    expect(sameIndices([0, 3, 4], V.sample.indices)).toBe(false);
  });
  it("a tampered row is caught: wrong chunk key -> decrypt mismatch; a dropped proof element -> proof length 2 of 3", () => {
    const sample = fx.sampleByPurchase("pur-merged-national")!;
    const row = sample.rows[0]!;
    const badKey = verifySampleRows({ rows: [{ ...row, chunkKey: V.chunks[1]!.chunkKey }] }, e("esc-national"))[0]!;
    expect(badKey).toMatchObject({ ok: false, decrypt: "mismatch" });
    const short = verifySampleRows({ rows: [{ ...row, cipherProof: row.cipherProof.slice(1) }] }, e("esc-national"))[0]!;
    expect(short.cipher).toEqual({ ok: false, expected: 3, got: 2 });
  });
});

describe("complaint re-verification", () => {
  it("the swap complaint: both proofs ok, derived leaf differs from the committed one, decrypted row is the swapped record", () => {
    const c = verifyComplaint(fx.complaintByPurchase("pur-ev-swap")!, e("esc-ev-swap"));
    expect(c.cipher).toEqual({ ok: true, expected: 3, got: 3 });
    expect(c.plain).toEqual({ ok: true, expected: 3, got: 3 });
    expect(c.cheat).toBe(true);
    expect(c.derivedLeaf).toBe(V.swappedChunk.derivedPlainLeaf);
    expect(c.committedLeaf).toBe(V.chunks[3]!.plainLeaf);
    expect(c.decryptedRow?.endsWith("simulated-swapped")).toBe(true);
    expect(c.contractWouldAccept).toBe(true);
  });
  it("without a revealed key the decryption check cannot run and the contract would not accept", () => {
    const stored = { ...fx.complaintByPurchase("pur-ev-swap")!, revealedKey: undefined };
    const c = verifyComplaint(stored, e("esc-ev-swap"));
    expect(c.cheat).toBeNull();
    expect(c.contractWouldAccept).toBe(false);
    expect(c.note).toMatch(/No revealed key/);
  });
  it("an honest chunk complained about is refused: the derived leaf matches the committed one", () => {
    const honest = { ...fx.complaintByPurchase("pur-ev-swap")!, chunkIndex: 0, chunk: V.chunks[0]!.cipher, cipherProof: V.chunks[0]!.cipherProof, plainLeaf: V.chunks[0]!.plainLeaf, plainProof: V.chunks[0]!.plainProof };
    const c = verifyComplaint(honest, e("esc-national"));
    expect(c.cipher?.ok).toBe(true);
    expect(c.plain.ok).toBe(true);
    expect(c.cheat).toBe(false);
    expect(c.contractWouldAccept).toBe(false);
  });
  it("a promise complaint re-runs only the plain-leaf proof and says so", () => {
    const promise = { ...fx.complaintByPurchase("pur-ev-swap")!, kind: "promise" as const, chunkIndex: 0, chunk: V.chunks[0]!.plain, cipherProof: [], plainLeaf: V.chunks[0]!.plainLeaf, plainProof: V.chunks[0]!.plainProof };
    const c = verifyComplaint(promise, e("esc-national"));
    expect(c.cipher).toBeNull();
    expect(c.plain.ok).toBe(true);
    expect(c.cheat).toBeNull();
    expect(c.contractWouldAccept).toBe(true);
    expect(c.note).toMatch(/ecrecover/);
  });
});

describe("terms checks", () => {
  it("the revealed key matches the commitment; a zero key is unknown; a wrong key does not match", () => {
    expect(revealedKeyMatches(V.perBuyerKey, V.keyCommitment)).toBe(true);
    expect(revealedKeyMatches(`0x${"0".repeat(64)}` as Hex, V.keyCommitment)).toBeUndefined();
    expect(revealedKeyMatches(V.chunks[0]!.chunkKey, V.keyCommitment)).toBe(false);
  });
  it("checkProof reports the expected sibling count for the index", () => {
    expect(checkProof({ root: V.rootPlain, leaf: V.chunks[6]!.plainLeaf, index: 6, proof: V.chunks[6]!.plainProof, chunkCount: 7 })).toEqual({ ok: true, expected: V.chunks[6]!.plainProof.length, got: V.chunks[6]!.plainProof.length });
  });
});
