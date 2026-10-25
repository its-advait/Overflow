import {
  buildMismatchComplaint,
  buildTree,
  checkMismatch,
  ComplaintNotWarrantedError,
  decryptChunk,
  getProof,
  hashLeaf,
  parseChunk,
  pickSampleIndices,
  toBytes,
  toHexString,
  verifyProof,
  verifyRecordPromise,
  verifySample,
  type MerkleTree,
  type RevealedChunkKey,
} from "@overflow/recourse-crypto";
import type { Address, Hex, SampleRow, SampleVerdict } from "@overflow/schemas";

// ---------------------------------------------------------------------------
// Buyer-side recourse evidence (docs/SPEC.md "Recourse"): pure functions over
// @overflow/recourse-crypto that produce exactly what the escrow detail page
// shows and what the contract checks. Nothing here touches a chain or a
// database; run.ts feeds it bytes and stores what comes back.
// ---------------------------------------------------------------------------

export interface SampleInput {
  cipherChunks: readonly Uint8Array[];
  plainLeaves: readonly Hex[];
  rootCipher: Hex;
  rootPlain: Hex;
  chunkCount: number;
  /** The sampled indices and the chunk keys the seller revealed for them. */
  revealed: readonly RevealedChunkKey[];
}

/** The deterministic SIMULATED sample randomness: keccak256(salt || "sample-v1"); recorded so a reader can re-derive the draw. */
export const SAMPLE_RANDOMNESS_LABEL = "sample-v1";

/** Draw `count` distinct indices in [0, chunkCount) from `randomness` the way the buyer did (pickSampleIndices(n, count, bytes)). */
export function drawSample(count: number, chunkCount: number, randomness: Hex): number[] {
  return pickSampleIndices(chunkCount, count, randomness);
}

/**
 * Verify every sampled chunk as the buyer does before funding: ciphertext proves under rootCipher, the published
 * plain leaf proves under rootPlain, and the revealed k_i decrypts the ciphertext to that leaf. Returns one
 * SampleRow per index with the decoded record when decryption succeeded.
 */
export function verifySampleRows(input: SampleInput): SampleRow[] {
  const cipherTree = buildTree(input.cipherChunks.map(hashLeaf));
  const plainTree = buildTree(input.plainLeaves);
  return input.revealed.map(({ index, chunkKey }) => {
    const cipherChunk = input.cipherChunks[index];
    const plainLeaf = input.plainLeaves[index];
    if (cipherChunk === undefined || plainLeaf === undefined) throw new Error(`sample index ${index} out of range`);
    const cipherProof = getProof(cipherTree, index);
    const plainProof = getProof(plainTree, index);
    const verdict = verifySample(cipherChunk, chunkKey, plainLeaf, {
      index,
      cipherProof,
      plainProof,
      rootCipher: input.rootCipher,
      rootPlain: input.rootPlain,
      chunkCount: input.chunkCount,
    });
    const row: SampleRow = {
      index,
      cipherChunk: toHexString(cipherChunk),
      chunkKey,
      plainLeaf,
      cipherProof,
      plainProof,
      verified: verdict.ok ? "ok" : verdict.reason,
    };
    if (verdict.ok) {
      row.plainChunk = toHexString(verdict.plainChunk);
      try {
        const parsed = parseChunk(verdict.plainChunk);
        row.timestamp = parsed.timestamp.toString();
        row.row = parsed.row;
      } catch {
        // A chunk that verifies but does not parse as a record is left without row text; the judge rejects it.
      }
    }
    return row;
  });
}

export interface JudgeInput {
  rows: readonly SampleRow[];
  /** The manifest's CSV header; every decoded row must have the same column count. */
  header: string;
  sourceKey: Address;
  /** Unix seconds; the minimum record timestamp the seller promised. */
  minTimestamp: bigint;
}

export interface SampleJudgment {
  verdict: SampleVerdict;
  reason: string;
  judge: string;
}

/** The rule the SIMULATED judge applies; named in every sample record so nobody mistakes it for a model. */
export const RULE_JUDGE = "rule:recourse-sample-v1 (SIMULATED, no model)";

/**
 * Deterministic sample judgment: every row verified, every record parses with the manifest's column count,
 * and every record honours the source promise (signer = sourceKey, timestamp >= minTimestamp). Any failure is
 * a `skip` naming the first failing row.
 */
export async function judgeSample(input: JudgeInput): Promise<SampleJudgment> {
  const columns = input.header.split(",").length;
  const skip = (reason: string): SampleJudgment => ({ verdict: "skip", reason, judge: RULE_JUDGE });
  if (input.rows.length === 0) return skip("no sampled rows to judge");
  for (const row of input.rows) {
    if (row.verified !== "ok") return skip(`chunk ${row.index} failed verification: ${row.verified}`);
    if (!row.plainChunk || row.row === undefined) return skip(`chunk ${row.index} decrypted but is not a parseable record`);
    const got = row.row.split(",").length;
    if (got !== columns) return skip(`chunk ${row.index} has ${got} columns, the manifest header has ${columns}`);
    const promise = await verifyRecordPromise(row.plainChunk, { sourceKey: input.sourceKey, minTimestamp: input.minTimestamp });
    if (!promise.ok) return skip(`chunk ${row.index} breaks the source promise: ${promise.reason} (${promise.detail})`);
  }
  return {
    verdict: "buy",
    reason: `${input.rows.length} sampled chunks verified (both Merkle proofs, decrypt to the committed leaf), parse as ${columns}-column records and carry ${input.sourceKey} signatures with timestamps >= ${input.minTimestamp}`,
    judge: RULE_JUDGE,
  };
}

export interface MismatchScan {
  /** Index of the first chunk whose decryption does not hash to its committed plain leaf; undefined when all match. */
  index: number | undefined;
  checked: number;
}

/** After the reveal: decrypt everything with k and find the first chunk that betrays the commitment. */
export function findFirstMismatch(cipherChunks: readonly Uint8Array[], plainLeaves: readonly Hex[], revealedKey: Hex): MismatchScan {
  for (let i = 0; i < cipherChunks.length; i++) {
    const leaf = plainLeaves[i];
    if (leaf === undefined) throw new Error(`plain leaf ${i} missing`);
    if (hashLeaf(decryptChunk(cipherChunks[i]!, revealedKey, i)).toLowerCase() !== leaf.toLowerCase()) return { index: i, checked: i + 1 };
  }
  return { index: undefined, checked: cipherChunks.length };
}

export interface MismatchEvidence {
  kind: "mismatch";
  chunkIndex: number;
  /** complainMismatch calldata. */
  chunk: Hex;
  cipherProof: Hex[];
  plainLeaf: Hex;
  plainProof: Hex[];
  derivedLeaf: Hex;
  decryptedRow: string | undefined;
  cipherProofVerified: boolean;
  plainProofVerified: boolean;
  cheatVerified: boolean;
  detail: string;
}

export interface MismatchEvidenceInput {
  index: number;
  cipherChunks: readonly Uint8Array[];
  plainLeaves: readonly Hex[];
  revealedKey: Hex;
  rootCipher: Hex;
  rootPlain: Hex;
  chunkCount: number;
}

/**
 * Build the complaint exactly as the contract will check it, then re-verify every piece: both proofs against the
 * committed roots and the derived leaf against the committed one. Throws ComplaintNotWarrantedError when the
 * chunk is honest, so a false complaint is never built, let alone sent.
 */
export function buildMismatchEvidence(input: MismatchEvidenceInput): MismatchEvidence {
  const args = buildMismatchComplaint({
    index: input.index,
    cipherChunks: input.cipherChunks,
    plainLeaves: input.plainLeaves,
    revealedKey: input.revealedKey,
    rootCipher: input.rootCipher,
    rootPlain: input.rootPlain,
  });
  const cipherProofVerified = verifyProof({ root: input.rootCipher, leaf: hashLeaf(args.cipherChunk), index: input.index, proof: args.cipherProof, chunkCount: input.chunkCount });
  const plainProofVerified = verifyProof({ root: input.rootPlain, leaf: args.plainLeaf, index: input.index, proof: args.plainProof, chunkCount: input.chunkCount });
  const check = checkMismatch(input.index, args.cipherChunk, input.revealedKey, args.plainLeaf);
  let decryptedRow: string | undefined;
  try {
    decryptedRow = parseChunk(decryptChunk(args.cipherChunk, input.revealedKey, input.index)).row;
  } catch {
    decryptedRow = undefined;
  }
  return {
    kind: "mismatch",
    chunkIndex: input.index,
    chunk: args.cipherChunk,
    cipherProof: args.cipherProof,
    plainLeaf: args.plainLeaf,
    plainProof: args.plainProof,
    derivedLeaf: check.derivedLeaf,
    decryptedRow,
    cipherProofVerified,
    plainProofVerified,
    cheatVerified: check.mismatch,
    detail:
      `chunk ${input.index}: ciphertext proves under rootCipher (${args.cipherProof.length} siblings), committed plain leaf ${args.plainLeaf} proves under rootPlain ` +
      `(${args.plainProof.length} siblings), but decrypt(chunk, k_${input.index}) hashes to ${check.derivedLeaf}`,
  };
}

export { ComplaintNotWarrantedError, toBytes };
export type { MerkleTree };
