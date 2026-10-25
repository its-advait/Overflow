import {
  concatHex,
  encodeAbiParameters,
  encodePacked,
  hexToBytes,
  keccak256,
  recoverAddress,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { CHUNK_SIZE, hashLeaf, keyCommitment, merkleRoot } from "./merkle";

/**
 * Delivery cryptography (docs/SPEC.md "Delivery cryptography"), mirrored by contracts/src/RecourseCrypto.sol.
 *   k      = keccak256(abi.encodePacked(sellerSecret, orderId, buyer))   per-buyer key, fresh per sale
 *   k_i    = keccak256(abi.encodePacked(k, uint256 i))                   chunk key
 *   ks_j   = keccak256(abi.encodePacked(k_i, uint256 j))                 keystream block j (32 bytes)
 *   c_i    = p_i XOR (ks_0 || ks_1 || ... ) truncated to 160 bytes
 *   keyCommitment = keccak256(k); rootPlain = merkleRoot(hashLeaf(p_i)); rootCipher = merkleRoot(hashLeaf(c_i)).
 */

export const BLOCK_SIZE = 32 as const;
export const BLOCKS_PER_CHUNK = CHUNK_SIZE / BLOCK_SIZE; // 5

const uint = (n: number | bigint): bigint => {
  const v = BigInt(n);
  if (v < 0n) throw new Error("index must be non-negative");
  return v;
};

function assertBytes32(x: Hex, name: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(x)) throw new Error(`${name} must be bytes32`);
}

/** Per-buyer delivery key. A revealed key is public, so each sale derives a fresh one. */
export function deriveKey(sellerSecret: Hex, orderId: Hex, buyer: Address): Hex {
  assertBytes32(sellerSecret, "sellerSecret");
  assertBytes32(orderId, "orderId");
  return keccak256(encodePacked(["bytes32", "bytes32", "address"], [sellerSecret, orderId, buyer]));
}

export function chunkKey(key: Hex, i: number | bigint): Hex {
  assertBytes32(key, "key");
  return keccak256(encodePacked(["bytes32", "uint256"], [key, uint(i)]));
}

export function keystreamBlock(chunkKey_: Hex, j: number | bigint): Hex {
  assertBytes32(chunkKey_, "chunkKey");
  return keccak256(encodePacked(["bytes32", "uint256"], [chunkKey_, uint(j)]));
}

/** XOR a 160-byte chunk with the keystream of `chunkKey_`. Symmetric: encrypt and decrypt are the same. */
export function xorChunk(chunkKey_: Hex, chunk: Hex): Hex {
  const data = hexToBytes(chunk);
  if (data.length !== CHUNK_SIZE) throw new Error(`chunk must be ${CHUNK_SIZE} bytes, got ${data.length}`);
  const out = new Uint8Array(CHUNK_SIZE);
  for (let j = 0; j < BLOCKS_PER_CHUNK; j++) {
    const ks = hexToBytes(keystreamBlock(chunkKey_, j));
    for (let b = 0; b < BLOCK_SIZE; b++) {
      const idx = j * BLOCK_SIZE + b;
      out[idx] = (data[idx] as number) ^ (ks[b] as number);
    }
  }
  return toHex(out);
}

export const encryptChunk = (key: Hex, i: number, plain: Hex): Hex => xorChunk(chunkKey(key, i), plain);
export const decryptChunk = (key: Hex, i: number, cipher: Hex): Hex => xorChunk(chunkKey(key, i), cipher);

export type DeliveryCommitment = {
  keyCommitment: Hex;
  rootPlain: Hex;
  rootCipher: Hex;
  plainLeaves: Hex[];
  cipherChunks: Hex[];
  cipherLeaves: Hex[];
  chunkCount: number;
};

/** Everything the seller commits onchain for `plainChunks` under `key`, plus the ciphertext to serve. */
export function commitDelivery(key: Hex, plainChunks: readonly Hex[]): DeliveryCommitment {
  if (plainChunks.length === 0) throw new Error("no chunks");
  const cipherChunks = plainChunks.map((p, i) => encryptChunk(key, i, p));
  const plainLeaves = plainChunks.map(hashLeaf);
  const cipherLeaves = cipherChunks.map(hashLeaf);
  return {
    keyCommitment: keyCommitment(key),
    rootPlain: merkleRoot(plainLeaves),
    rootCipher: merkleRoot(cipherLeaves),
    plainLeaves,
    cipherChunks,
    cipherLeaves,
    chunkCount: plainChunks.length,
  };
}

/** The 160-byte record: 95-byte payload (first 8 bytes = uint64 big-endian timestamp) + 65-byte signature (r,s,v). */
export const RECORD_LAYOUT = {
  payloadBytes: 95,
  timestampBytes: 8,
  signatureBytes: 65,
} as const;

export function recordTimestamp(chunk: Hex): bigint {
  const b = hexToBytes(chunk);
  if (b.length !== CHUNK_SIZE && b.length !== RECORD_LAYOUT.payloadBytes) throw new Error("expected a record or payload");
  let t = 0n;
  for (let k = 0; k < RECORD_LAYOUT.timestampBytes; k++) t = (t << 8n) | BigInt(b[k] as number);
  return t;
}

/** Split a 160-byte record into its 95-byte payload and 65-byte (r, s, v) signature. */
export function splitRecord(record: Hex): { payload: Hex; signature: Hex } {
  const b = hexToBytes(record);
  if (b.length !== CHUNK_SIZE) throw new Error(`record must be ${CHUNK_SIZE} bytes`);
  return { payload: toHex(b.slice(0, RECORD_LAYOUT.payloadBytes)), signature: toHex(b.slice(RECORD_LAYOUT.payloadBytes)) };
}

/** Assemble a record from a 95-byte payload and a 65-byte signature. */
export function buildRecord(payload: Hex, signature: Hex): Hex {
  if (hexToBytes(payload).length !== RECORD_LAYOUT.payloadBytes) throw new Error("payload must be 95 bytes");
  if (hexToBytes(signature).length !== RECORD_LAYOUT.signatureBytes) throw new Error("signature must be 65 bytes");
  return concatHex([payload, signature]);
}

/** Payload = uint64 big-endian timestamp || 87 data bytes. */
export function buildPayload(timestamp: bigint | number, data: Hex): Hex {
  const d = hexToBytes(data);
  if (d.length !== RECORD_LAYOUT.payloadBytes - RECORD_LAYOUT.timestampBytes) throw new Error("data must be 87 bytes");
  return concatHex([toHex(BigInt(timestamp), { size: 8 }), data]);
}

/** The hash the data source signs: plain keccak256 of the payload (no EIP-191 prefix), as the contract checks it. */
export const payloadHash = (payload: Hex): Hex => keccak256(payload);

/**
 * Offchain mirror of complainPromise's decision: true when the record breaks the promised source key
 * (signature does not recover to it) or the promised minimum timestamp. Both zero means no promise exists.
 */
export async function promiseBroken(record: Hex, sourceKey: Address | null, minTimestamp: bigint): Promise<boolean> {
  const noSource = sourceKey === null || /^0x0{40}$/i.test(sourceKey);
  if (noSource && minTimestamp === 0n) throw new Error("no promise to check");
  const { payload, signature } = splitRecord(record);
  if (!noSource) {
    let recovered: Address | null = null;
    try {
      recovered = await recoverAddress({ hash: payloadHash(payload), signature });
    } catch {
      recovered = null;
    }
    if (recovered === null || recovered.toLowerCase() !== (sourceKey as string).toLowerCase()) return true;
  }
  return minTimestamp !== 0n && recordTimestamp(payload) < minTimestamp;
}

/** Local check a buyer runs before complaining: does cipher chunk i decrypt to the committed plain leaf? */
export function chunkMatches(key: Hex, i: number, cipherChunk: Hex, plainLeaf: Hex): boolean {
  return hashLeaf(decryptChunk(key, i, cipherChunk)).toLowerCase() === plainLeaf.toLowerCase();
}

// Re-exported so callers importing crypto.ts get the full ABI-encoding helpers they may need for terms.
export { concatHex, encodeAbiParameters };
