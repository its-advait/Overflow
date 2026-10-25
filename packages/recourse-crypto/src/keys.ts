import { encodePacked, keccak256, type Address, type Hex } from "viem";
import { AddressSchema, Bytes32Schema } from "@overflow/schemas";
import { assertLength, concatBytes, toBytes, xorBytes } from "./bytes";
import { CHUNK_BYTES } from "./record";

// ---------------------------------------------------------------------------
// Keys and keystream (docs/SPEC.md "Delivery cryptography").
//
//   k          = keccak256(abi.encodePacked(sellerSecret, orderId, buyer))
//   k_i        = keccak256(abi.encodePacked(k, uint256 i))
//   block_j    = keccak256(abi.encodePacked(k_i, uint256 j))
//   c_i        = p_i XOR (block_0 || block_1 || ... )     (160 bytes = blocks 0..4)
//   commitment = keccak256(k)
//
// A revealed k_i exposes nothing about k or any other chunk key.
// ---------------------------------------------------------------------------

export const KEYSTREAM_BLOCK_BYTES = 32;
export const BLOCKS_PER_CHUNK = Math.ceil(CHUNK_BYTES / KEYSTREAM_BLOCK_BYTES); // 5

function assertIndex(i: bigint | number, what: string): bigint {
  const v = BigInt(i);
  if (v < 0n || v >= 1n << 256n) throw new Error(`${what} out of uint256 range`);
  return v;
}

/** Per-buyer key: fresh for every sale because a revealed key is public. */
export function perBuyerKey(sellerSecret: Hex, orderId: Hex, buyer: Address): Hex {
  return keccak256(
    encodePacked(
      ["bytes32", "bytes32", "address"],
      [Bytes32Schema.parse(sellerSecret), Bytes32Schema.parse(orderId), AddressSchema.parse(buyer)],
    ),
  );
}

/** k_i = keccak256(abi.encodePacked(k, uint256 i)). */
export function chunkKey(k: Hex, i: bigint | number): Hex {
  return keccak256(encodePacked(["bytes32", "uint256"], [Bytes32Schema.parse(k), assertIndex(i, "chunk index")]));
}

/** keystream block j = keccak256(abi.encodePacked(k_i, uint256 j)). */
export function keystreamBlock(chunkKeyHex: Hex, j: bigint | number): Hex {
  return keccak256(encodePacked(["bytes32", "uint256"], [Bytes32Schema.parse(chunkKeyHex), assertIndex(j, "block index")]));
}

/** First `length` keystream bytes for a chunk key (blocks 0, 1, 2, ...). */
export function keystream(chunkKeyHex: Hex, length: number = CHUNK_BYTES): Uint8Array {
  if (!Number.isInteger(length) || length < 0) throw new Error("keystream length must be a non-negative integer");
  const blocks: Uint8Array[] = [];
  for (let j = 0; j * KEYSTREAM_BLOCK_BYTES < length; j++) blocks.push(toBytes(keystreamBlock(chunkKeyHex, j)));
  return concatBytes(...blocks).subarray(0, length);
}

/** XOR a 160-byte chunk with its keystream. Encryption and decryption are the same operation. */
export function applyChunkKey(chunk: Hex | Uint8Array, chunkKeyHex: Hex): Uint8Array {
  const bytes = toBytes(chunk);
  assertLength(bytes, CHUNK_BYTES, "chunk");
  return xorBytes(bytes, keystream(chunkKeyHex, CHUNK_BYTES));
}

export function encryptChunk(plain: Hex | Uint8Array, k: Hex, i: bigint | number): Uint8Array {
  return applyChunkKey(plain, chunkKey(k, i));
}

export function decryptChunk(cipher: Hex | Uint8Array, k: Hex, i: bigint | number): Uint8Array {
  return applyChunkKey(cipher, chunkKey(k, i));
}

/** Decrypt with a revealed chunk key only (what a buyer holds during sampling). */
export function decryptChunkWithChunkKey(cipher: Hex | Uint8Array, chunkKeyHex: Hex): Uint8Array {
  return applyChunkKey(cipher, chunkKeyHex);
}

/** keyCommitment = keccak256(k); the seller publishes this and later reveals k. */
export function keyCommitment(k: Hex): Hex {
  return keccak256(Bytes32Schema.parse(k));
}

export function encryptDataset(plainChunks: readonly (Hex | Uint8Array)[], k: Hex): Uint8Array[] {
  return plainChunks.map((p, i) => encryptChunk(p, k, i));
}

export function decryptDataset(cipherChunks: readonly (Hex | Uint8Array)[], k: Hex): Uint8Array[] {
  return cipherChunks.map((c, i) => decryptChunk(c, k, i));
}
