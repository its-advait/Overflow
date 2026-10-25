import { toHex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { buildTree, hashLeaf } from "./merkle";
import {
  MANIFEST_HASH_ABI,
  RECORD_FORMAT,
  computeManifestHash,
  headerHash,
  verifyManifest,
  type DatasetManifest,
  type ManifestHashInput,
} from "./manifest";
import { buildRecordChunk } from "./record";
import { simulatedBytes32 } from "./vectors";

const b32 = (n: number) => toHex(n, { size: 32 });
const base: ManifestHashInput = {
  rootPlain: b32(2),
  chunkCount: 7,
  sourceKey: privateKeyToAddress(simulatedBytes32("source-signer")),
  minTimestamp: "1704067200",
  header: "month,state,brand,units,simulated",
};

describe("manifestHash", () => {
  it("pins the ABI field order", () => {
    expect(MANIFEST_HASH_ABI.map((p) => `${p.type} ${p.name}`)).toEqual([
      "bytes32 rootPlain",
      "uint256 chunkCount",
      "address sourceKey",
      "uint64 minTimestamp",
      "bytes32 headerHash",
    ]);
  });

  it("is deterministic and sensitive to every field", () => {
    const h = computeManifestHash(base);
    expect(computeManifestHash({ ...base })).toBe(h);
    const variants: ManifestHashInput[] = [
      { ...base, rootPlain: b32(3) },
      { ...base, chunkCount: 8 },
      { ...base, sourceKey: privateKeyToAddress(simulatedBytes32("wrong-signer")) },
      { ...base, minTimestamp: "1704067201" },
      { ...base, header: "month,state,brand,units" },
    ];
    const hashes = new Set(variants.map(computeManifestHash));
    expect(hashes.size).toBe(variants.length);
    expect(hashes.has(h)).toBe(false);
  });

  it("rejects an invalid source key, a zero chunk count and a uint64 overflow", () => {
    expect(() => computeManifestHash({ ...base, sourceKey: "0x12" as never })).toThrow();
    expect(() => computeManifestHash({ ...base, chunkCount: 0 })).toThrow();
    expect(() => computeManifestHash({ ...base, minTimestamp: (1n << 64n).toString() })).toThrow(/uint64/);
    expect(() => headerHash("")).toThrow();
  });
});

describe("verifyManifest", () => {
  async function honestManifest(): Promise<DatasetManifest> {
    const key = simulatedBytes32("source-signer");
    const rows = ["2024-01,CA,Voltara,1200,simulated", "2024-01,TX,Voltara,800,simulated", "2024-02,CA,Voltara,1250,simulated"];
    const chunks = await Promise.all(rows.map((row, i) => buildRecordChunk({ row, timestamp: 1706745600n + BigInt(i) }, key)));
    const leaves = chunks.map(hashLeaf);
    const rootPlain = buildTree(leaves).root;
    const fields = { rootPlain, chunkCount: leaves.length, sourceKey: privateKeyToAddress(key), minTimestamp: "1706745600", header: base.header };
    return {
      simulated: true,
      productId: "test-dataset",
      title: "SIMULATED test dataset",
      fields: ["month", "state", "brand", "units"],
      granularity: "monthly",
      plainLeaves: leaves,
      manifestHash: computeManifestHash(fields),
      recordFormat: RECORD_FORMAT,
      ...fields,
    };
  }

  it("accepts an honest manifest", async () => {
    expect(verifyManifest(await honestManifest())).toEqual({ ok: true });
  });

  it("rejects a tampered leaf, a tampered hash and a leaf-count mismatch", async () => {
    const m = await honestManifest();
    const tamperedLeaf = { ...m, plainLeaves: [b32(99), ...m.plainLeaves.slice(1)] };
    expect(verifyManifest(tamperedLeaf)).toMatchObject({ ok: false, reason: "root-mismatch" });
    const tamperedHash = { ...m, minTimestamp: "1" };
    expect(verifyManifest(tamperedHash)).toMatchObject({ ok: false, reason: "hash-mismatch" });
    const shortLeaves = { ...m, plainLeaves: m.plainLeaves.slice(1) };
    expect(verifyManifest(shortLeaves)).toMatchObject({ ok: false, reason: "schema" });
    expect(verifyManifest({ ...m, simulated: false })).toMatchObject({ ok: false, reason: "schema" });
  });
});
