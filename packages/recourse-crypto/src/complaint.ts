import type { Address, Hex } from "viem";
import { Bytes32Schema } from "@overflow/schemas";
import { toBytes, toHexString } from "./bytes";
import { decryptChunk } from "./keys";
import { buildTree, getProof, hashLeaf, type MerkleTree } from "./merkle";
import { verifyRecordPromise, type RecordVerdict } from "./record";

// ---------------------------------------------------------------------------
// Complaint builders. Each returns exactly the calldata arguments of the
// matching OverflowEscrow function and refuses to build a complaint the
// contract would reject ("an allegation alone never refunds").
//
//   complainMismatch(uint256 i, bytes cipherChunk, bytes32[] cipherProof,
//                    bytes32 plainLeaf, bytes32[] plainProof)
//   complainPromise(uint256 i, bytes plainChunk, bytes32[] plainProof)
// ---------------------------------------------------------------------------

export class ComplaintNotWarrantedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplaintNotWarrantedError";
  }
}

export interface MismatchComplaintArgs {
  i: bigint;
  cipherChunk: Hex;
  cipherProof: Hex[];
  plainLeaf: Hex;
  plainProof: Hex[];
}

export interface PromiseComplaintArgs {
  i: bigint;
  plainChunk: Hex;
  plainProof: Hex[];
}

export interface MismatchCheck {
  mismatch: boolean;
  /** keccak256(decrypt(cipherChunk, k_i)); what the contract derives. */
  derivedLeaf: Hex;
  committedLeaf: Hex;
}

/** What complainMismatch computes: derive k_i from the revealed key, decrypt, hash, compare. */
export function checkMismatch(index: number, cipherChunk: Hex | Uint8Array, revealedKey: Hex, committedPlainLeaf: Hex): MismatchCheck {
  const derivedLeaf = hashLeaf(decryptChunk(cipherChunk, revealedKey, index));
  const committedLeaf = Bytes32Schema.parse(committedPlainLeaf);
  return { mismatch: derivedLeaf.toLowerCase() !== committedLeaf.toLowerCase(), derivedLeaf, committedLeaf };
}

export interface MismatchComplaintInput {
  index: number;
  /** All ciphertext chunks the buyer downloaded (they verified against rootCipher before funding). */
  cipherChunks: readonly (Hex | Uint8Array)[];
  /** All plain leaves from the seller's manifest (they verify against rootPlain). */
  plainLeaves: readonly Hex[];
  /** k, as revealed onchain by revealKey(). */
  revealedKey: Hex;
  /** Optional cross-checks against the escrow terms. */
  rootCipher?: Hex;
  rootPlain?: Hex;
}

/**
 * Tier 2. Throws ComplaintNotWarrantedError when the chunk decrypts to the
 * committed plain leaf, or when the supplied data does not match the roots.
 */
export function buildMismatchComplaint(input: MismatchComplaintInput): MismatchComplaintArgs {
  const { index, cipherChunks, plainLeaves, revealedKey } = input;
  if (cipherChunks.length !== plainLeaves.length) {
    throw new Error(`cipherChunks (${cipherChunks.length}) and plainLeaves (${plainLeaves.length}) must have the same length`);
  }
  const cipherChunk = cipherChunks[index];
  const plainLeaf = plainLeaves[index];
  if (cipherChunk === undefined || plainLeaf === undefined) throw new Error(`index ${index} out of range`);

  const cipherTree: MerkleTree = buildTree(cipherChunks.map(hashLeaf));
  const plainTree: MerkleTree = buildTree(plainLeaves);
  if (input.rootCipher !== undefined && cipherTree.root !== input.rootCipher.toLowerCase()) {
    throw new ComplaintNotWarrantedError("ciphertext chunks do not Merkle to the committed rootCipher");
  }
  if (input.rootPlain !== undefined && plainTree.root !== input.rootPlain.toLowerCase()) {
    throw new ComplaintNotWarrantedError("plain leaves do not Merkle to the committed rootPlain");
  }

  const check = checkMismatch(index, cipherChunk, revealedKey, plainLeaf);
  if (!check.mismatch) {
    throw new ComplaintNotWarrantedError(`chunk ${index} decrypts to the committed plain leaf; the contract would revert`);
  }
  return {
    i: BigInt(index),
    cipherChunk: toHexString(toBytes(cipherChunk)),
    cipherProof: getProof(cipherTree, index),
    plainLeaf: Bytes32Schema.parse(plainLeaf),
    plainProof: getProof(plainTree, index),
  };
}

export interface PromiseComplaintInput {
  index: number;
  /** All decrypted plaintext chunks (after the key reveal). */
  plainChunks: readonly (Hex | Uint8Array)[];
  /** The promised source signer, from the escrow terms. */
  sourceKey: Address;
  /** The promised minimum timestamp (unix seconds), from the escrow terms. */
  minTimestamp: bigint;
  rootPlain?: Hex;
}

export interface PromiseComplaintResult extends PromiseComplaintArgs {
  verdict: Extract<RecordVerdict, { ok: false }>;
}

/**
 * Tier 3. Throws ComplaintNotWarrantedError when the record honors the promise
 * (right signer, timestamp not below the minimum).
 */
export async function buildPromiseComplaint(input: PromiseComplaintInput): Promise<PromiseComplaintResult> {
  const { index, plainChunks, sourceKey, minTimestamp } = input;
  const plainChunk = plainChunks[index];
  if (plainChunk === undefined) throw new Error(`index ${index} out of range`);
  const plainTree = buildTree(plainChunks.map(hashLeaf));
  if (input.rootPlain !== undefined && plainTree.root !== input.rootPlain.toLowerCase()) {
    throw new ComplaintNotWarrantedError("plaintext chunks do not Merkle to the committed rootPlain");
  }
  const verdict = await verifyRecordPromise(plainChunk, { sourceKey, minTimestamp });
  if (verdict.ok) {
    throw new ComplaintNotWarrantedError(`record ${index} is signed by the promised source with an acceptable timestamp; the contract would revert`);
  }
  return {
    i: BigInt(index),
    plainChunk: toHexString(toBytes(plainChunk)),
    plainProof: getProof(plainTree, index),
    verdict,
  };
}
