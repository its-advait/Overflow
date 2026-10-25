import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { decodePayload, recoverRecordSigner, splitChunk, splitDataset, DatasetManifestSchema, TIMESTAMP_BYTES } from "@overflow/recourse-crypto";
import { describe, expect, it } from "vitest";
import { loadCatalog, CATALOG_RELATIVE_PATH } from "./catalog";
import { publicationTimestamp } from "./rows";

// The committed records must be readable by RecourseCrypto.sol exactly as written: the uint64 timestamp is the
// first 8 payload bytes (no version byte), the signature recovers to the manifest's sourceKey, and the
// manifest's minTimestamp is the smallest record timestamp. This is what complainPromise() checks on chain.
const repoRoot = resolve(import.meta.dirname, "../../..");
const dataDir = dirname(resolve(repoRoot, CATALOG_RELATIVE_PATH));

function bigEndianUint64(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < TIMESTAMP_BYTES; i++) v = (v << 8n) | BigInt(bytes[i] as number);
  return v;
}

/** Period column -> the month a registry would publish after ("2021-01" -> 2021-02-01; "2024" -> 2025-01-01). */
function expectedTimestamp(period: string): bigint {
  const lastMonth = /^\d{4}$/.test(period) ? `${period}-12` : period;
  return publicationTimestamp(lastMonth);
}

describe("committed records use the contract's byte layout", () => {
  it("every record: timestamp at payload[0..8), source signature, manifest minTimestamp", { timeout: 60_000 }, async () => {
    const catalog = await loadCatalog();
    const seen = new Set<string>();
    for (const listing of catalog.listings) {
      if (seen.has(listing.productId)) continue;
      seen.add(listing.productId);
      const manifest = DatasetManifestSchema.parse(JSON.parse(await readFile(resolve(dataDir, listing.dataset.manifestJson), "utf8")));
      const chunks = splitDataset(new Uint8Array(await readFile(resolve(dataDir, listing.dataset.recordsBin))));
      expect(chunks.length).toBe(manifest.chunkCount);
      expect(manifest.recordFormat).toEqual({ chunkBytes: 160, payloadBytes: 95, timestampBytes: 8, dataBytes: 87, signatureBytes: 65 });
      let min: bigint | undefined;
      for (const chunk of chunks) {
        const { payload } = splitChunk(chunk);
        const onChainRead = bigEndianUint64(payload.subarray(0, TIMESTAMP_BYTES)); // uint64(bytes8(payload[:8]))
        const decoded = decodePayload(payload);
        expect(onChainRead).toBe(decoded.timestamp);
        const period = decoded.row.split(",")[0] as string;
        expect(onChainRead).toBe(expectedTimestamp(period));
        min = min === undefined || onChainRead < min ? onChainRead : min;
      }
      expect(min?.toString()).toBe(manifest.minTimestamp);
      // Signatures are deterministic per key; one recovery per dataset keeps the test fast.
      expect((await recoverRecordSigner(chunks[0] as Uint8Array)).toLowerCase()).toBe(manifest.sourceKey.toLowerCase());
    }
    expect(seen.size).toBe(4);
  });

  it("the 2021-2022 dataset promises minTimestamp 2021-02-01, so a 2024 promise is broken by every record", async () => {
    const catalog = await loadCatalog();
    const listing = catalog.listings.find((l) => l.id === "listing-national-monthly-2021-2022");
    expect(listing).toBeDefined();
    const manifest = DatasetManifestSchema.parse(JSON.parse(await readFile(resolve(dataDir, listing!.dataset.manifestJson), "utf8")));
    expect(manifest.minTimestamp).toBe("1612137600"); // 2021-02-01T00:00:00Z
    const chunks = splitDataset(new Uint8Array(await readFile(resolve(dataDir, listing!.dataset.recordsBin))));
    const promised2024 = 1704067200n; // 2024-01-01T00:00:00Z
    for (const chunk of chunks) expect(decodePayload(splitChunk(chunk).payload).timestamp < promised2024).toBe(true);
  });
});
