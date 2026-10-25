import {
  checkMismatch,
  decryptChunk,
  decryptChunkWithChunkKey,
  expectedProofLength,
  hashLeaf,
  keyCommitment,
  parseChunk,
  pickSampleIndices,
  verifyProof,
} from "@overflow/recourse-crypto";
import type { ComplaintRecord, EscrowOrder, Hex, SampleRecord } from "@overflow/schemas";

// ---------------------------------------------------------------------------
// Browser-side re-verification of the recourse evidence the service stored
// (docs/SPEC.md "Recourse"). Pure functions over @overflow/recourse-crypto,
// the same code the buyer and the contract fixtures use. The page shows the
// service's verdict and this page's own next to each other; neither is a
// success the chain confirmed, that is what the CheatProven log is for.
// ---------------------------------------------------------------------------

export interface ProofCheck {
  ok: boolean;
  /** Siblings the contract expects for this index and chunk count. */
  expected: number;
  got: number;
}

export function checkProof(input: { root: Hex; leaf: Hex; index: number; proof: readonly Hex[]; chunkCount: number }): ProofCheck {
  const expected = expectedProofLength(input.index, input.chunkCount);
  let ok = false;
  try {
    ok = input.proof.length === expected && verifyProof({ root: input.root, leaf: input.leaf, index: input.index, proof: input.proof, chunkCount: input.chunkCount });
  } catch {
    ok = false;
  }
  return { ok, expected, got: input.proof.length };
}

export type DecryptCheck = "ok" | "mismatch" | "error";

export interface RowCheck {
  index: number;
  cipher: ProofCheck;
  plain: ProofCheck;
  /** decrypt(cipherChunk, k_i) hashes to the committed plain leaf. */
  decrypt: DecryptCheck;
  derivedLeaf?: Hex;
  /** Record text decoded in this browser (absent when the chunk is not a record). */
  row?: string;
  timestamp?: string;
  ok: boolean;
}

type Terms = Pick<EscrowOrder, "rootCipher" | "rootPlain" | "chunkCount">;

/** Re-run the buyer's three checks on every stored sample row against the escrow's committed roots. */
export function verifySampleRows(sample: Pick<SampleRecord, "rows">, terms: Terms): RowCheck[] {
  return sample.rows.map((r) => {
    const cipher = checkProof({ root: terms.rootCipher, leaf: hashLeaf(r.cipherChunk), index: r.index, proof: r.cipherProof, chunkCount: terms.chunkCount });
    const plain = checkProof({ root: terms.rootPlain, leaf: r.plainLeaf, index: r.index, proof: r.plainProof, chunkCount: terms.chunkCount });
    let decrypt: DecryptCheck = "error";
    let derivedLeaf: Hex | undefined;
    let row: string | undefined;
    let timestamp: string | undefined;
    try {
      const plainChunk = decryptChunkWithChunkKey(r.cipherChunk, r.chunkKey);
      derivedLeaf = hashLeaf(plainChunk);
      decrypt = derivedLeaf.toLowerCase() === r.plainLeaf.toLowerCase() ? "ok" : "mismatch";
      try {
        const parsed = parseChunk(plainChunk);
        row = parsed.row;
        timestamp = parsed.timestamp.toString();
      } catch {
        // verifies as bytes but is not a 160-byte record; the judge's reason says so
      }
    } catch {
      decrypt = "error";
    }
    return {
      index: r.index,
      cipher,
      plain,
      decrypt,
      ...(derivedLeaf ? { derivedLeaf } : {}),
      ...(row !== undefined ? { row } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      ok: cipher.ok && plain.ok && decrypt === "ok",
    };
  });
}

/** The indices the buyer must have drawn from the recorded randomness (pickSampleIndices(n, count, bytes)). */
export function rederiveIndices(randomness: Hex, count: number, chunkCount: number): number[] {
  try {
    return pickSampleIndices(chunkCount, count, randomness);
  } catch {
    return [];
  }
}

export function sameIndices(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** keccak256(abi.encodePacked(k)) == keyCommitment: the key the seller revealed is the one the terms committed to. */
export function revealedKeyMatches(revealedKey: Hex | undefined, commitment: Hex): boolean | undefined {
  if (!revealedKey || /^0x0+$/.test(revealedKey)) return undefined;
  try {
    return keyCommitment(revealedKey).toLowerCase() === commitment.toLowerCase();
  } catch {
    return false;
  }
}

export interface ComplaintCheck {
  kind: ComplaintRecord["kind"];
  chunkIndex: number;
  /** Mismatch only: the ciphertext chunk under rootCipher. */
  cipher: ProofCheck | null;
  /** The committed plain leaf (mismatch) or the record's leaf (promise) under rootPlain. */
  plain: ProofCheck;
  committedLeaf: Hex;
  derivedLeaf?: Hex;
  /** Mismatch: decrypt(chunk, k_i) differs from the committed leaf. null when the browser could not re-check (no key, or a promise complaint). */
  cheat: boolean | null;
  decryptedRow?: string;
  /** All the checks the contract runs and this browser could re-run passed. */
  contractWouldAccept: boolean;
  note?: string;
}

/** Re-run complainMismatch's checks (both proofs, decrypt, compare) on the stored complaint; promise complaints get the proof check only. */
export function verifyComplaint(complaint: ComplaintRecord, terms: Terms, revealedKey?: Hex): ComplaintCheck {
  const i = complaint.chunkIndex;
  if (complaint.kind === "promise") {
    const plain = checkProof({ root: terms.rootPlain, leaf: hashLeaf(complaint.chunk), index: i, proof: complaint.plainProof, chunkCount: terms.chunkCount });
    return {
      kind: "promise",
      chunkIndex: i,
      cipher: null,
      plain,
      committedLeaf: complaint.plainLeaf,
      cheat: null,
      contractWouldAccept: plain.ok,
      note: "The signed-record promise (source key, minimum timestamp) is checked by the contract with ecrecover; this page re-runs only the Merkle proof.",
    };
  }
  const cipher = checkProof({ root: terms.rootCipher, leaf: hashLeaf(complaint.chunk), index: i, proof: complaint.cipherProof, chunkCount: terms.chunkCount });
  const plain = checkProof({ root: terms.rootPlain, leaf: complaint.plainLeaf, index: i, proof: complaint.plainProof, chunkCount: terms.chunkCount });
  const key = complaint.revealedKey ?? revealedKey;
  if (!key || /^0x0+$/.test(key)) {
    return { kind: "mismatch", chunkIndex: i, cipher, plain, committedLeaf: complaint.plainLeaf, cheat: null, contractWouldAccept: false, note: "No revealed key: the decryption check cannot run until KeyRevealed is indexed." };
  }
  let cheat: boolean | null = null;
  let derivedLeaf: Hex | undefined;
  let decryptedRow: string | undefined;
  try {
    const c = checkMismatch(i, complaint.chunk, key, complaint.plainLeaf);
    cheat = c.mismatch;
    derivedLeaf = c.derivedLeaf;
    try {
      decryptedRow = parseChunk(decryptChunk(complaint.chunk, key, i)).row;
    } catch {
      decryptedRow = undefined;
    }
  } catch {
    cheat = null;
  }
  return {
    kind: "mismatch",
    chunkIndex: i,
    cipher,
    plain,
    committedLeaf: complaint.plainLeaf,
    ...(derivedLeaf ? { derivedLeaf } : {}),
    cheat,
    ...(decryptedRow !== undefined ? { decryptedRow } : {}),
    contractWouldAccept: cipher.ok && plain.ok && cheat === true,
  };
}
