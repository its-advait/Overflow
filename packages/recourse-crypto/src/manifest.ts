import { encodeAbiParameters, keccak256, parseAbiParameters, stringToBytes, type Hex } from "viem";
import { AddressSchema, Bytes32Schema, GranularitySchema, UintStringSchema } from "@overflow/schemas";
import { z } from "zod";
import { MAX_UINT64 } from "./bytes";
import { buildTree } from "./merkle";
import { CHUNK_BYTES, DATA_BYTES, PAYLOAD_BYTES, RECORD_VERSION, SIGNATURE_BYTES } from "./record";

// ---------------------------------------------------------------------------
// Dataset manifest (docs/SPEC.md "Delivery cryptography": the seller publishes
// every plain leaf plus chunkCount in the manifest; the escrow terms carry
// manifestHash). rootPlain is buyer-independent, so one manifest serves every
// order for a dataset. rootCipher and keyCommitment stay per order.
//
// manifestHash is over fixed ABI-encoded fields, never JSON:
//   keccak256(abi.encode(bytes32 rootPlain, uint256 chunkCount, address sourceKey,
//                        uint64 minTimestamp, bytes32 headerHash))
//   headerHash = keccak256(bytes(header))      header = the CSV header line
// ---------------------------------------------------------------------------

const Uint64Schema = UintStringSchema.refine((v) => !/^\d+$/.test(v) || BigInt(v) <= MAX_UINT64, "exceeds uint64");

export const MANIFEST_HASH_ABI = parseAbiParameters(
  "bytes32 rootPlain, uint256 chunkCount, address sourceKey, uint64 minTimestamp, bytes32 headerHash",
);

export const ManifestHashInputSchema = z.object({
  rootPlain: Bytes32Schema,
  chunkCount: z.number().int().positive(),
  /** Address the seller promises signed every record. */
  sourceKey: AddressSchema,
  /** Unix seconds; minimum record timestamp the seller promises. */
  minTimestamp: Uint64Schema,
  /** The CSV header line (column names), which defines what each record row means. */
  header: z.string().min(1),
});
export type ManifestHashInput = z.infer<typeof ManifestHashInputSchema>;

/** keccak256 of the UTF-8 header line. */
export function headerHash(header: string): Hex {
  if (typeof header !== "string" || header.length === 0) throw new Error("header must be a non-empty string");
  return keccak256(stringToBytes(header));
}

export function computeManifestHash(input: ManifestHashInput): Hex {
  const m = ManifestHashInputSchema.parse(input);
  return keccak256(
    encodeAbiParameters(MANIFEST_HASH_ABI, [
      m.rootPlain,
      BigInt(m.chunkCount),
      m.sourceKey,
      BigInt(m.minTimestamp),
      headerHash(m.header),
    ]),
  );
}

export const RecordFormatSchema = z.object({
  version: z.literal(RECORD_VERSION),
  chunkBytes: z.literal(CHUNK_BYTES),
  payloadBytes: z.literal(PAYLOAD_BYTES),
  dataBytes: z.literal(DATA_BYTES),
  signatureBytes: z.literal(SIGNATURE_BYTES),
});

export const RECORD_FORMAT: z.infer<typeof RecordFormatSchema> = {
  version: RECORD_VERSION,
  chunkBytes: CHUNK_BYTES,
  payloadBytes: PAYLOAD_BYTES,
  dataBytes: DATA_BYTES,
  signatureBytes: SIGNATURE_BYTES,
};

/** The manifest file a seller publishes for one dataset (data/datasets/<productId>/manifest.json). */
export const DatasetManifestSchema = z
  .object({
    /** Always true for Overflow demo data; the UI must label it. */
    simulated: z.literal(true),
    productId: z.string().min(1),
    title: z.string().min(1),
    /** CSV header line; the record rows follow it column for column. */
    header: z.string().min(1),
    /** Data fields (the header minus label-only columns such as `simulated`). */
    fields: z.array(z.string().min(1)).min(1),
    granularity: GranularitySchema,
    chunkCount: z.number().int().positive(),
    rootPlain: Bytes32Schema,
    /** keccak256(0x00 || chunk_i) for every chunk, in order; exactly chunkCount entries. */
    plainLeaves: z.array(Bytes32Schema).min(1),
    sourceKey: AddressSchema,
    minTimestamp: Uint64Schema,
    manifestHash: Bytes32Schema,
    recordFormat: RecordFormatSchema,
  })
  .refine((m) => m.plainLeaves.length === m.chunkCount, {
    message: "plainLeaves must have exactly chunkCount entries",
    path: ["plainLeaves"],
  });
export type DatasetManifest = z.infer<typeof DatasetManifestSchema>;

export type ManifestVerdict =
  | { ok: true }
  | { ok: false; reason: "schema" | "root-mismatch" | "hash-mismatch"; detail: string };

/** Buyer side: the leaves Merkle to rootPlain and manifestHash recomputes from the fixed fields. */
export function verifyManifest(input: unknown): ManifestVerdict {
  const parsed = DatasetManifestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "schema", detail: parsed.error.message };
  const m = parsed.data;
  const root = buildTree(m.plainLeaves).root;
  if (root !== m.rootPlain.toLowerCase()) {
    return { ok: false, reason: "root-mismatch", detail: `leaves Merkle to ${root}, manifest says ${m.rootPlain}` };
  }
  const expected = computeManifestHash(m);
  if (expected !== m.manifestHash.toLowerCase()) {
    return { ok: false, reason: "hash-mismatch", detail: `fields hash to ${expected}, manifest says ${m.manifestHash}` };
  }
  return { ok: true };
}
