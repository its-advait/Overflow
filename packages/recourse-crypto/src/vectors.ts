import { keccak256, stringToBytes, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { AddressSchema, Bytes32Schema, HexSchema } from "@overflow/schemas";
import { z } from "zod";
import { toHexString } from "./bytes";
import { buildMismatchComplaint, buildPromiseComplaint } from "./complaint";
import { commitDataset } from "./commit";
import { chunkKey, keystream } from "./keys";
import { buildTree, getProof, hashLeaf } from "./merkle";
import { CHUNK_BYTES, DATA_BYTES, PAYLOAD_BYTES, RECORD_VERSION, SIGNATURE_BYTES, buildRecordChunk, splitChunk } from "./record";
import { pickSampleIndices, revealChunkKeys } from "./sample";

// ---------------------------------------------------------------------------
// Golden vectors shared with contracts/test/fixtures/recourse-vectors.json.
// Everything here is SIMULATED test data: throwaway keys derived from labels,
// a synthetic 7-row dataset. Regenerating must produce byte-identical JSON.
// ---------------------------------------------------------------------------

export const VECTORS_VERSION = 1;
export const VECTORS_RELATIVE_PATH = "test/vectors.json";
export const FIXTURE_RELATIVE_PATH = "contracts/test/fixtures/recourse-vectors.json";

const Uint = z.string().regex(/^(0|[1-9]\d*)$/);

const ChunkVectorSchema = z.object({
  index: z.number().int().nonnegative(),
  row: z.string(),
  timestamp: Uint,
  payload: HexSchema,
  signature: HexSchema,
  plain: HexSchema,
  plainLeaf: Bytes32Schema,
  chunkKey: Bytes32Schema,
  keystream: HexSchema,
  cipher: HexSchema,
  cipherLeaf: Bytes32Schema,
  plainProof: z.array(Bytes32Schema),
  cipherProof: z.array(Bytes32Schema),
});

export const GoldenVectorsSchema = z.object({
  version: z.literal(VECTORS_VERSION),
  description: z.string(),
  record: z.object({
    version: z.number().int(),
    chunkBytes: z.literal(CHUNK_BYTES),
    payloadBytes: z.literal(PAYLOAD_BYTES),
    dataBytes: z.literal(DATA_BYTES),
    signatureBytes: z.literal(SIGNATURE_BYTES),
    signedDigest: z.string(),
  }),
  sourceSigner: z.object({ label: z.string(), privateKey: Bytes32Schema, address: AddressSchema }),
  wrongSigner: z.object({ label: z.string(), privateKey: Bytes32Schema, address: AddressSchema }),
  sellerSecret: Bytes32Schema,
  orderId: Bytes32Schema,
  buyer: AddressSchema,
  perBuyerKey: Bytes32Schema,
  keyCommitment: Bytes32Schema,
  chunkCount: z.number().int().positive(),
  rootPlain: Bytes32Schema,
  rootCipher: Bytes32Schema,
  chunks: z.array(ChunkVectorSchema),
  sample: z.object({
    randomBytes: Bytes32Schema,
    count: z.number().int().nonnegative(),
    indices: z.array(z.number().int().nonnegative()),
    revealedChunkKeys: z.array(z.object({ index: z.number().int().nonnegative(), chunkKey: Bytes32Schema })),
  }),
  swappedChunk: z.object({
    description: z.string(),
    index: z.number().int().nonnegative(),
    row: z.string(),
    plain: HexSchema,
    cipher: HexSchema,
    cipherLeaf: Bytes32Schema,
    rootCipher: Bytes32Schema,
    derivedPlainLeaf: Bytes32Schema,
    complainMismatch: z.object({
      i: Uint,
      cipherChunk: HexSchema,
      cipherProof: z.array(Bytes32Schema),
      plainLeaf: Bytes32Schema,
      plainProof: z.array(Bytes32Schema),
    }),
  }),
  wrongSourceRecord: z.object({
    description: z.string(),
    index: z.number().int().nonnegative(),
    promise: z.object({ sourceKey: AddressSchema, minTimestamp: Uint }),
    plain: HexSchema,
    signature: HexSchema,
    recoveredSigner: AddressSchema,
    plainLeaf: Bytes32Schema,
    rootPlain: Bytes32Schema,
    complainPromise: z.object({
      i: Uint,
      plainChunk: HexSchema,
      plainProof: z.array(Bytes32Schema),
    }),
  }),
});
export type GoldenVectors = z.infer<typeof GoldenVectorsSchema>;

/** Throwaway key material derived from a label. SIMULATED; never holds funds. */
export function simulatedBytes32(label: string): Hex {
  return keccak256(stringToBytes(`overflow.simulated.${label}`));
}

/** SIMULATED dataset: synthetic monthly EV registration rows, one per chunk. */
export const SIMULATED_ROWS: readonly string[] = [
  "2025-01,US,CA,BEV,12894,simulated",
  "2025-01,US,TX,BEV,6210,simulated",
  "2025-02,US,CA,BEV,13377,simulated",
  "2025-02,US,TX,PHEV,2045,simulated",
  "2025-03,US,CA,BEV,14102,simulated",
  "2025-03,US,NY,BEV,5589,simulated",
  "2025-03,US,TX,BEV,6744,simulated",
];

/** 2025-01-01T00:00:00Z plus one day per row. */
const BASE_TIMESTAMP = 1735689600n;
const SWAPPED_INDEX = 3;
const WRONG_SOURCE_INDEX = 5;
const SAMPLE_COUNT = 3;

export async function generateGoldenVectors(): Promise<GoldenVectors> {
  const sourcePrivateKey = simulatedBytes32("source-signer");
  const wrongPrivateKey = simulatedBytes32("wrong-signer");
  const sellerSecret = simulatedBytes32("seller-secret");
  const orderId = simulatedBytes32("order-id");
  const buyer = privateKeyToAddress(simulatedBytes32("buyer"));
  const sourceAddress = privateKeyToAddress(sourcePrivateKey);
  const wrongAddress = privateKeyToAddress(wrongPrivateKey);

  const fields = SIMULATED_ROWS.map((row, i) => ({ row, timestamp: BASE_TIMESTAMP + BigInt(i) * 86400n }));
  const plainChunks = await Promise.all(fields.map((f) => buildRecordChunk(f, sourcePrivateKey)));
  const honest = commitDataset({ plainChunks, sellerSecret, orderId, buyer });

  const chunks = honest.plainChunks.map((plain, index) => {
    const f = fields[index] as (typeof fields)[number];
    const { payload, signature } = splitChunk(plain);
    const ck = chunkKey(honest.perBuyerKey, index);
    return {
      index,
      row: f.row,
      timestamp: f.timestamp.toString(),
      payload: toHexString(payload),
      signature: toHexString(signature),
      plain: toHexString(plain),
      plainLeaf: honest.plainLeaves[index] as Hex,
      chunkKey: ck,
      keystream: toHexString(keystream(ck, CHUNK_BYTES)),
      cipher: toHexString(honest.cipherChunks[index] as Uint8Array),
      cipherLeaf: honest.cipherLeaves[index] as Hex,
      plainProof: getProof(honest.plainTree, index),
      cipherProof: getProof(honest.cipherTree, index),
    };
  });

  const randomBytes = simulatedBytes32("sample-randomness");
  const indices = pickSampleIndices(honest.chunkCount, SAMPLE_COUNT, randomBytes);

  // Swap attack: after the sample, the seller ships ciphertext whose chunk 3 is
  // a different (still source-signed) record. rootPlain stays the honest one, so
  // the buyer's manifest leaf 3 no longer matches what c_3 decrypts to.
  const swappedFields = { row: "2025-02,US,TX,PHEV,9999,simulated-swapped", timestamp: (fields[SWAPPED_INDEX] as (typeof fields)[number]).timestamp };
  const swappedPlain = await buildRecordChunk(swappedFields, sourcePrivateKey);
  const swappedPlainChunks = honest.plainChunks.map((c, i) => (i === SWAPPED_INDEX ? swappedPlain : c));
  const swapped = commitDataset({ plainChunks: swappedPlainChunks, sellerSecret, orderId, buyer });
  const mismatch = buildMismatchComplaint({
    index: SWAPPED_INDEX,
    cipherChunks: swapped.cipherChunks,
    plainLeaves: honest.plainLeaves,
    revealedKey: honest.perBuyerKey,
    rootCipher: swapped.rootCipher,
    rootPlain: honest.rootPlain,
  });

  // Broken promise: record 5 carries the honest payload but a signature from a
  // key that is not the promised source.
  const wrongSourcePayloadFields = fields[WRONG_SOURCE_INDEX] as (typeof fields)[number];
  const wrongSourcePlain = await buildRecordChunk(wrongSourcePayloadFields, wrongPrivateKey);
  const wrongSourcePlainChunks = honest.plainChunks.map((c, i) => (i === WRONG_SOURCE_INDEX ? wrongSourcePlain : c));
  const wrongSourceTree = buildTree(wrongSourcePlainChunks.map(hashLeaf));
  const promise = { sourceKey: sourceAddress, minTimestamp: BASE_TIMESTAMP };
  const promiseComplaint = await buildPromiseComplaint({
    index: WRONG_SOURCE_INDEX,
    plainChunks: wrongSourcePlainChunks,
    ...promise,
    rootPlain: wrongSourceTree.root,
  });

  const vectors: GoldenVectors = {
    version: VECTORS_VERSION,
    description:
      "SIMULATED golden vectors for Overflow Recourse delivery cryptography. Keys are derived from labels and never hold funds. Solidity (OverflowEscrow) and @overflow/recourse-crypto must both reproduce every value.",
    record: {
      version: RECORD_VERSION,
      chunkBytes: CHUNK_BYTES,
      payloadBytes: PAYLOAD_BYTES,
      dataBytes: DATA_BYTES,
      signatureBytes: SIGNATURE_BYTES,
      signedDigest: "keccak256(payload), raw ECDSA, no EIP-191 prefix, signature = r || s || v (v in {27, 28})",
    },
    sourceSigner: { label: "SIMULATED data source", privateKey: sourcePrivateKey, address: sourceAddress },
    wrongSigner: { label: "SIMULATED impostor source", privateKey: wrongPrivateKey, address: wrongAddress },
    sellerSecret,
    orderId,
    buyer,
    perBuyerKey: honest.perBuyerKey,
    keyCommitment: honest.keyCommitment,
    chunkCount: honest.chunkCount,
    rootPlain: honest.rootPlain,
    rootCipher: honest.rootCipher,
    chunks,
    sample: {
      randomBytes,
      count: SAMPLE_COUNT,
      indices,
      revealedChunkKeys: revealChunkKeys(honest.perBuyerKey, indices),
    },
    swappedChunk: {
      description: `Chunk ${SWAPPED_INDEX} swapped after sampling; rootCipher is the swapped dataset's, rootPlain is the honest one, so complainMismatch succeeds.`,
      index: SWAPPED_INDEX,
      row: swappedFields.row,
      plain: toHexString(swappedPlain),
      cipher: toHexString(swapped.cipherChunks[SWAPPED_INDEX] as Uint8Array),
      cipherLeaf: swapped.cipherLeaves[SWAPPED_INDEX] as Hex,
      rootCipher: swapped.rootCipher,
      derivedPlainLeaf: hashLeaf(swappedPlain),
      complainMismatch: {
        i: mismatch.i.toString(),
        cipherChunk: mismatch.cipherChunk,
        cipherProof: mismatch.cipherProof,
        plainLeaf: mismatch.plainLeaf,
        plainProof: mismatch.plainProof,
      },
    },
    wrongSourceRecord: {
      description: `Record ${WRONG_SOURCE_INDEX} signed by the impostor key; ecrecover != promised sourceKey, so complainPromise succeeds.`,
      index: WRONG_SOURCE_INDEX,
      promise: { sourceKey: promise.sourceKey, minTimestamp: promise.minTimestamp.toString() },
      plain: toHexString(wrongSourcePlain),
      signature: toHexString(splitChunk(wrongSourcePlain).signature),
      recoveredSigner: wrongAddress,
      plainLeaf: hashLeaf(wrongSourcePlain),
      rootPlain: wrongSourceTree.root,
      complainPromise: {
        i: promiseComplaint.i.toString(),
        plainChunk: promiseComplaint.plainChunk,
        plainProof: promiseComplaint.plainProof,
      },
    },
  };
  return GoldenVectorsSchema.parse(vectors);
}

/** Canonical serialization; vector stability tests compare this string byte for byte. */
export function serializeGoldenVectors(vectors: GoldenVectors): string {
  return `${JSON.stringify(vectors, null, 2)}\n`;
}

export function parseGoldenVectors(json: string): GoldenVectors {
  return GoldenVectorsSchema.parse(JSON.parse(json));
}
