import { keccak256, recoverAddress } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  CHUNK_BYTES,
  DATA_BYTES,
  PAYLOAD_BYTES,
  TIMESTAMP_BYTES,
  SIGNATURE_BYTES,
  buildRecordChunk,
  decodePayload,
  encodePayload,
  joinChunks,
  parseChunk,
  payloadHash,
  recoverRecordSigner,
  splitDataset,
  verifyRecordPromise,
} from "./record";
import { simulatedBytes32 } from "./vectors";

const sourceKey = simulatedBytes32("test-source");
const sourceAddress = privateKeyToAddress(sourceKey);
const otherKey = simulatedBytes32("test-other");

describe("record format", () => {
  it("has the documented sizes", () => {
    expect(PAYLOAD_BYTES).toBe(95);
    expect(TIMESTAMP_BYTES).toBe(8);
    expect(DATA_BYTES).toBe(87);
    expect(SIGNATURE_BYTES).toBe(65);
    expect(CHUNK_BYTES).toBe(160);
  });

  it("encodes the big-endian uint64 timestamp at byte 0 (as RecourseCrypto.sol reads it) and zero-padded data", () => {
    const payload = encodePayload({ timestamp: 0x0102030405060708n, row: "a,b" });
    expect(payload.length).toBe(95);
    expect(Array.from(payload.subarray(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(payload.subarray(8, 11))).toEqual([0x61, 0x2c, 0x62]);
    expect(payload.subarray(11).every((b) => b === 0)).toBe(true);
  });

  it("round-trips through decodePayload, including multi-byte UTF-8", () => {
    const row = "2025-01,Zürich,€12";
    const decoded = decodePayload(encodePayload({ timestamp: 1735689600n, row }));
    expect(decoded).toMatchObject({ timestamp: 1735689600n, row });
  });

  it("accepts an 87-byte row and rejects 88 bytes", () => {
    expect(() => encodePayload({ timestamp: 1n, row: "x".repeat(87) })).not.toThrow();
    expect(() => encodePayload({ timestamp: 1n, row: "x".repeat(88) })).toThrow(/at most 87/);
    expect(() => encodePayload({ timestamp: 1n, row: "é".repeat(44) })).toThrow(/at most 87/);
  });

  it("rejects NUL in rows, negative or oversized timestamps and wrong length", () => {
    expect(() => encodePayload({ timestamp: 1n, row: "a\u0000b" })).toThrow();
    expect(() => encodePayload({ timestamp: -1n, row: "a" })).toThrow();
    expect(() => encodePayload({ timestamp: 1n << 64n, row: "a" })).toThrow();
    const payload = encodePayload({ timestamp: 1n, row: "a" });
    expect(() => decodePayload(payload.subarray(1))).toThrow(/95 bytes/);
  });

  it("signs keccak256(payload) with no EIP-191 prefix and recovers the source", async () => {
    const chunk = await buildRecordChunk({ timestamp: 1735689600n, row: "2025-01,US,CA,BEV,12894" }, sourceKey);
    expect(chunk.length).toBe(160);
    const parsed = parseChunk(chunk);
    expect(parsed.signature.length).toBe(65);
    expect([27, 28]).toContain(parsed.signature[64]);
    expect(payloadHash(parsed.payload)).toBe(keccak256(parsed.payload));
    expect(await recoverRecordSigner(chunk)).toBe(sourceAddress);
    expect(await recoverAddress({ hash: keccak256(parsed.payload), signature: parsed.signature })).toBe(sourceAddress);
  });

  it("is deterministic (RFC 6979) so vectors are stable", async () => {
    const a = await buildRecordChunk({ timestamp: 5n, row: "r" }, sourceKey);
    const b = await buildRecordChunk({ timestamp: 5n, row: "r" }, sourceKey);
    expect(a).toEqual(b);
  });

  it("verifyRecordPromise accepts honest records and names the broken promise", async () => {
    const honest = await buildRecordChunk({ timestamp: 1735689600n, row: "ok" }, sourceKey);
    expect(await verifyRecordPromise(honest, { sourceKey: sourceAddress, minTimestamp: 1735689600n })).toMatchObject({ ok: true, signer: sourceAddress });

    const wrongSource = await buildRecordChunk({ timestamp: 1735689600n, row: "ok" }, otherKey);
    expect(await verifyRecordPromise(wrongSource, { sourceKey: sourceAddress, minTimestamp: 0n })).toMatchObject({ ok: false, reason: "wrong-source" });

    const stale = await buildRecordChunk({ timestamp: 1735689599n, row: "ok" }, sourceKey);
    expect(await verifyRecordPromise(stale, { sourceKey: sourceAddress, minTimestamp: 1735689600n })).toMatchObject({ ok: false, reason: "stale-timestamp" });

    const garbage = new Uint8Array(honest);
    garbage[159] = 0x05; // invalid v
    expect(await verifyRecordPromise(garbage, { sourceKey: sourceAddress, minTimestamp: 0n })).toMatchObject({ ok: false });
  });

  it("splits and joins datasets in whole chunks only", async () => {
    const chunks = await Promise.all([1n, 2n, 3n].map((t) => buildRecordChunk({ timestamp: t, row: `r${t}` }, sourceKey)));
    const joined = joinChunks(chunks);
    expect(joined.length).toBe(480);
    expect(splitDataset(joined)).toEqual(chunks);
    expect(() => splitDataset(joined.subarray(1))).toThrow(/multiple of 160/);
    expect(() => splitDataset(new Uint8Array(0))).toThrow();
  });
});
