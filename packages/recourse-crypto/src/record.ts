import { keccak256, recoverAddress, type Address, type Hex } from "viem";
import { sign } from "viem/accounts";
import { AddressSchema, Bytes32Schema } from "@overflow/schemas";
import { z } from "zod";
import { MAX_UINT64, assertLength, bytesToUint64, concatBytes, toBytes, uint64Bytes } from "./bytes";

// ---------------------------------------------------------------------------
// Record format (see README "Record format"; this is a contract with Solidity).
//
//   chunk     = payload (95 bytes) || signature (65 bytes)         = 160 bytes
//   payload   = version (1 byte, 0x01) || timestamp (uint64 BE, 8) || data (86)
//   data      = one UTF-8 CSV row, right-padded with 0x00
//   signature = ECDSA over keccak256(payload), r || s || v, v in {27, 28},
//               no EIP-191 prefix (viem sign({ hash })).
// ---------------------------------------------------------------------------

export const RECORD_VERSION = 0x01;
export const VERSION_BYTES = 1;
export const TIMESTAMP_BYTES = 8;
export const DATA_BYTES = 86;
export const PAYLOAD_BYTES = VERSION_BYTES + TIMESTAMP_BYTES + DATA_BYTES; // 95
export const SIGNATURE_BYTES = 65;
export const CHUNK_BYTES = PAYLOAD_BYTES + SIGNATURE_BYTES; // 160

export const RecordFieldsSchema = z.object({
  /** Unix seconds, uint64. */
  timestamp: z.bigint().nonnegative().max(MAX_UINT64),
  /** One CSV row; at most 86 UTF-8 bytes; no NUL characters (NUL is the padding byte). */
  row: z.string().refine((r) => !r.includes("\u0000"), "row must not contain NUL"),
});
export type RecordFields = z.infer<typeof RecordFieldsSchema>;

export interface DecodedPayload {
  version: number;
  timestamp: bigint;
  row: string;
  /** The raw 86 data bytes including padding. */
  data: Uint8Array;
}

export interface ParsedRecord extends DecodedPayload {
  payload: Uint8Array;
  signature: Uint8Array;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** version || timestamp || data(86, right-padded with 0x00). Rejects rows longer than 86 bytes. */
export function encodePayload(fields: RecordFields): Uint8Array {
  const f = RecordFieldsSchema.parse(fields);
  const rowBytes = utf8Encoder.encode(f.row);
  if (rowBytes.length > DATA_BYTES) {
    throw new Error(`row is ${rowBytes.length} UTF-8 bytes; the record format allows at most ${DATA_BYTES}`);
  }
  const data = new Uint8Array(DATA_BYTES);
  data.set(rowBytes, 0);
  return concatBytes(new Uint8Array([RECORD_VERSION]), uint64Bytes(f.timestamp), data);
}

export function decodePayload(payloadInput: Hex | Uint8Array): DecodedPayload {
  const payload = toBytes(payloadInput);
  assertLength(payload, PAYLOAD_BYTES, "payload");
  const version = payload[0] as number;
  if (version !== RECORD_VERSION) throw new Error(`unsupported record version 0x${version.toString(16)}`);
  const timestamp = bytesToUint64(payload.subarray(VERSION_BYTES, VERSION_BYTES + TIMESTAMP_BYTES));
  const data = payload.subarray(VERSION_BYTES + TIMESTAMP_BYTES);
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  const row = utf8Decoder.decode(data.subarray(0, end));
  return { version, timestamp, row, data: new Uint8Array(data) };
}

/** keccak256(payload): the digest the source signs. No EIP-191 prefix. */
export function payloadHash(payload: Hex | Uint8Array): Hex {
  const p = toBytes(payload);
  assertLength(p, PAYLOAD_BYTES, "payload");
  return keccak256(p);
}

/** Raw ECDSA signature (65 bytes, r || s || v with v = 27 or 28) over keccak256(payload). */
export async function signPayload(payload: Hex | Uint8Array, privateKey: Hex): Promise<Uint8Array> {
  Bytes32Schema.parse(privateKey);
  return sign({ hash: payloadHash(payload), privateKey, to: "bytes" });
}

/** Builds a complete 160-byte record chunk signed by the data source. */
export async function buildRecordChunk(fields: RecordFields, sourcePrivateKey: Hex): Promise<Uint8Array> {
  const payload = encodePayload(fields);
  const signature = await signPayload(payload, sourcePrivateKey);
  return concatBytes(payload, signature);
}

export function splitChunk(chunkInput: Hex | Uint8Array): { payload: Uint8Array; signature: Uint8Array } {
  const chunk = toBytes(chunkInput);
  assertLength(chunk, CHUNK_BYTES, "chunk");
  return {
    payload: new Uint8Array(chunk.subarray(0, PAYLOAD_BYTES)),
    signature: new Uint8Array(chunk.subarray(PAYLOAD_BYTES)),
  };
}

export function parseChunk(chunkInput: Hex | Uint8Array): ParsedRecord {
  const { payload, signature } = splitChunk(chunkInput);
  return { ...decodePayload(payload), payload, signature };
}

/** ecrecover(keccak256(payload), signature). Throws on a malformed signature. */
export async function recoverRecordSigner(chunkInput: Hex | Uint8Array): Promise<Address> {
  const { payload, signature } = splitChunk(chunkInput);
  return recoverAddress({ hash: payloadHash(payload), signature });
}

export const SourcePromiseSchema = z.object({
  /** The address the seller promised signed every record. */
  sourceKey: AddressSchema,
  /** Minimum record timestamp (unix seconds) the seller promised. */
  minTimestamp: z.bigint().nonnegative().max(MAX_UINT64),
});
export type SourcePromise = z.infer<typeof SourcePromiseSchema>;

export type RecordVerdict =
  | { ok: true; signer: Address; timestamp: bigint }
  | {
      ok: false;
      reason: "wrong-source" | "stale-timestamp" | "malformed";
      signer?: Address;
      timestamp?: bigint;
      detail: string;
    };

/** Mirrors complainPromise(): a record honors the promise iff the signer matches and the timestamp is not stale. */
export async function verifyRecordPromise(chunkInput: Hex | Uint8Array, promise: SourcePromise): Promise<RecordVerdict> {
  const p = SourcePromiseSchema.parse(promise);
  let parsed: ParsedRecord;
  try {
    parsed = parseChunk(chunkInput);
  } catch (e) {
    return { ok: false, reason: "malformed", detail: e instanceof Error ? e.message : String(e) };
  }
  let signer: Address;
  try {
    signer = await recoverAddress({ hash: keccak256(parsed.payload), signature: parsed.signature });
  } catch (e) {
    return {
      ok: false,
      reason: "malformed",
      timestamp: parsed.timestamp,
      detail: `signature does not recover: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (signer.toLowerCase() !== p.sourceKey.toLowerCase()) {
    return {
      ok: false,
      reason: "wrong-source",
      signer,
      timestamp: parsed.timestamp,
      detail: `record signed by ${signer}, promised source ${p.sourceKey}`,
    };
  }
  if (parsed.timestamp < p.minTimestamp) {
    return {
      ok: false,
      reason: "stale-timestamp",
      signer,
      timestamp: parsed.timestamp,
      detail: `record timestamp ${parsed.timestamp} is below the promised minimum ${p.minTimestamp}`,
    };
  }
  return { ok: true, signer, timestamp: parsed.timestamp };
}

/** Splits a byte string into 160-byte chunks. Rejects lengths that are not a multiple of 160. */
export function splitDataset(bytesInput: Hex | Uint8Array): Uint8Array[] {
  const bytes = toBytes(bytesInput);
  if (bytes.length === 0 || bytes.length % CHUNK_BYTES !== 0) {
    throw new Error(`dataset must be a non-empty multiple of ${CHUNK_BYTES} bytes, got ${bytes.length}`);
  }
  const chunks: Uint8Array[] = [];
  for (let o = 0; o < bytes.length; o += CHUNK_BYTES) chunks.push(new Uint8Array(bytes.subarray(o, o + CHUNK_BYTES)));
  return chunks;
}

export function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  for (const c of chunks) assertLength(c, CHUNK_BYTES, "chunk");
  return concatBytes(...chunks);
}
