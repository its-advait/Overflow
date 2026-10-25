import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTree,
  computeManifestHash,
  hashLeaf,
  parseChunk,
  recoverRecordSigner,
  splitDataset,
  verifyManifest,
  DatasetManifestSchema,
} from "@overflow/recourse-crypto";
import { ResourceListingSchema, toAtomic } from "@overflow/schemas";
import { CatalogEntrySchema, parseCatalog, type CatalogEntry } from "./catalog";
import { generateDatasets } from "./generate";
import { LISTINGS } from "./listings";
import { STATES, buildRows, monthlyUnits, monthsBetween, publicationTimestamp } from "./rows";
import { SIMULATED_SOURCE_SIGNER_ADDRESS, SIMULATED_SOURCE_SIGNER_KEY, resolveSourceSignerKey } from "./signer";

const dataDir = resolve(import.meta.dirname, "../../..", "data");
const read = (rel: string) => readFile(resolve(dataDir, rel));
const catalogPromise = read("catalog.json").then((b) => parseCatalog(b.toString("utf8")));
const generatedPromise = generateDatasets({ sourcePrivateKey: SIMULATED_SOURCE_SIGNER_KEY, sourceAddress: SIMULATED_SOURCE_SIGNER_ADDRESS });

interface DecodedRow {
  period: string;
  state: string;
  brand: string;
  units: number;
  label: string;
  timestamp: bigint;
  chunk: Uint8Array;
}

async function decodeRecords(entry: CatalogEntry): Promise<DecodedRow[]> {
  const chunks = splitDataset(new Uint8Array(await read(entry.dataset.recordsBin)));
  return chunks.map((chunk) => {
    const r = parseChunk(chunk);
    const [period, state, brand, units, label] = r.row.split(",");
    if (!period || !state || !brand || !units || !label) throw new Error(`malformed row ${r.row}`);
    return { period, state, brand, units: Number(units), label, timestamp: r.timestamp, chunk };
  });
}

describe("data/ is deterministic", () => {
  it("regenerating with the simulated source key gives byte-identical files", { timeout: 60_000 }, async () => {
    const generated = await generatedPromise;
    expect(generated.files.size).toBe(13);
    for (const [rel, content] of generated.files) {
      const onDisk = await read(rel);
      const expected = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      expect(onDisk.equals(expected), `${rel} differs from a fresh generation`).toBe(true);
    }
  });

  it("the default signer is the golden vectors' simulated source and the env override is honoured", () => {
    expect(resolveSourceSignerKey({})).toEqual({ privateKey: SIMULATED_SOURCE_SIGNER_KEY, address: SIMULATED_SOURCE_SIGNER_ADDRESS, isDefault: true });
    const other = resolveSourceSignerKey({ SOURCE_SIGNER_KEY: `0x${"11".repeat(32)}` });
    expect(other.isDefault).toBe(false);
    expect(other.address).not.toBe(SIMULATED_SOURCE_SIGNER_ADDRESS);
    expect(() => resolveSourceSignerKey({ SOURCE_SIGNER_KEY: "not-a-key" })).toThrow();
  });
});

describe("catalog.json", () => {
  it("is labeled SIMULATED and every entry validates against ResourceListingSchema and CatalogEntrySchema", async () => {
    const catalog = await catalogPromise;
    expect(catalog.simulated).toBe(true);
    expect(catalog.sourceSigner.address).toBe(SIMULATED_SOURCE_SIGNER_ADDRESS);
    expect(catalog.listings.length).toBe(6);
    for (const entry of catalog.listings) {
      expect(() => ResourceListingSchema.parse(entry)).not.toThrow();
      expect(() => CatalogEntrySchema.parse(entry)).not.toThrow();
      expect(entry.simulated).toBe(true);
      expect(entry.title).toMatch(/SIMULATED/);
      expect(catalog.sellers.some((s) => s.id === entry.sellerId && s.simulated)).toBe(true);
    }
    expect(new Set(catalog.listings.map((l) => l.id)).size).toBe(6);
  });

  it("carries the prompt's prices, licenses and seats", async () => {
    const byId = new Map((await catalogPromise).listings.map((l) => [l.id, l]));
    const expectations: [string, string, string, number][] = [
      ["listing-national-monthly-2024-2026", "12", "company-use", 10],
      ["listing-california-monthly-2024-2026", "5", "company-use", 10],
      ["listing-national-annual-2024-2026", "6", "company-use", 10],
      ["listing-national-monthly-2021-2022", "4", "company-use", 10],
      ["listing-national-monthly-2024-2026-seller-b", "13", "company-use", 10],
      ["listing-national-monthly-2024-2026-single-user", "10", "single-user", 1],
    ];
    for (const [id, usdc, license, seats] of expectations) {
      const l = byId.get(id);
      expect(l, id).toBeDefined();
      expect(l!.priceAtomic).toBe(toAtomic(usdc));
      expect(l!.license).toBe(license);
      expect(l!.seats).toBe(seats);
    }
    expect(LISTINGS.map((l) => l.id)).toEqual(expectations.map((e) => e[0]));
  });

  it("the duplicate and single-user listings share the national monthly manifestHash; the others differ", async () => {
    const byId = new Map((await catalogPromise).listings.map((l) => [l.id, l]));
    const national = byId.get("listing-national-monthly-2024-2026")!;
    expect(byId.get("listing-national-monthly-2024-2026-seller-b")!.manifestHash).toBe(national.manifestHash);
    expect(byId.get("listing-national-monthly-2024-2026-single-user")!.manifestHash).toBe(national.manifestHash);
    expect(byId.get("listing-national-monthly-2024-2026-seller-b")!.sellerId).not.toBe(national.sellerId);
    const others = ["listing-california-monthly-2024-2026", "listing-national-annual-2024-2026", "listing-national-monthly-2021-2022"].map(
      (id) => byId.get(id)!.manifestHash,
    );
    expect(new Set([national.manifestHash, ...others]).size).toBe(4);
  });
});

describe("each listing's coverage metadata matches its rows", () => {
  it("regions, dates, granularity, fields, chunk count, signer and manifest all agree with records.bin", { timeout: 60_000 }, async () => {
    const catalog = await catalogPromise;
    for (const entry of catalog.listings) {
      const rows = await decodeRecords(entry);
      const manifest = DatasetManifestSchema.parse(JSON.parse((await read(entry.dataset.manifestJson)).toString("utf8")));
      const csvLines = (await read(entry.dataset.rowsCsv)).toString("utf8").split("\n").filter((l) => l.length > 0);

      // Counts and the human-readable twin.
      expect(rows.length, entry.id).toBe(entry.dataset.rowCount);
      expect(rows.length).toBe(entry.dataset.chunkCount);
      expect(manifest.chunkCount).toBe(rows.length);
      expect(csvLines[0]).toBe(manifest.header);
      expect(csvLines.slice(1)).toEqual(rows.map((r) => [r.period, r.state, r.brand, r.units, r.label].join(",")));

      // Fields: header minus the label column; every row carries the label.
      expect(manifest.header.split(",")).toEqual([...entry.coverage.fields, "simulated"]);
      expect(manifest.fields).toEqual(entry.coverage.fields);
      for (const r of rows) expect(r.label).toBe("simulated");

      // Regions: US-<state> for every state present, plus US iff the listing is national.
      const statesInRows = new Set(rows.map((r) => `US-${r.state}`));
      const stateRegions = entry.coverage.regions.filter((r) => r !== "US");
      expect(new Set(stateRegions)).toEqual(statesInRows);
      expect(entry.coverage.regions.includes("US")).toBe(statesInRows.size === STATES.length);

      // Dates and granularity.
      const periods = rows.map((r) => r.period).sort();
      const first = periods[0] as string;
      const last = periods[periods.length - 1] as string;
      expect(manifest.granularity).toBe(entry.coverage.granularity);
      if (entry.coverage.granularity === "monthly") {
        for (const p of periods) expect(p).toMatch(/^\d{4}-\d{2}$/);
        expect(entry.coverage.dateRange.start).toBe(`${first}-01`);
        expect(entry.coverage.dateRange.end.slice(0, 7)).toBe(last);
        expect(new Set(periods)).toEqual(new Set(monthsBetween(first, last)));
      } else {
        expect(entry.coverage.granularity).toBe("annual");
        for (const p of periods) expect(p).toMatch(/^\d{4}$/);
        expect(entry.coverage.dateRange.start.slice(0, 4)).toBe(first);
        expect(entry.coverage.dateRange.end.slice(0, 4)).toBe(last);
      }
      expect(entry.coverage.format).toBe("csv");
      expect(entry.coverage.asOf).toBe(catalog.generatedFor.asOf);
      expect(entry.coverage.asOf! >= entry.coverage.dateRange.end).toBe(true);

      // Every record is signed by the simulated registry feed and honours the promised minimum timestamp.
      let minSeen = rows[0]!.timestamp;
      const signers = await Promise.all(rows.map((r) => recoverRecordSigner(r.chunk)));
      for (const [i, r] of rows.entries()) {
        expect(signers[i]).toBe(catalog.sourceSigner.address);
        expect(r.timestamp >= BigInt(manifest.minTimestamp)).toBe(true);
        if (r.timestamp < minSeen) minSeen = r.timestamp;
      }
      expect(minSeen.toString()).toBe(manifest.minTimestamp);
      expect(manifest.sourceKey).toBe(catalog.sourceSigner.address);

      // Manifest binds the actual chunks and hashes to the catalog's manifestHash.
      for (const r of rows) expect(r.chunk.length).toBe(manifest.recordFormat.chunkBytes);
      expect(buildTree(rows.map((r) => hashLeaf(r.chunk))).root).toBe(manifest.rootPlain);
      expect(verifyManifest(manifest)).toEqual({ ok: true });
      expect(computeManifestHash(manifest)).toBe(entry.manifestHash);
      expect(manifest.manifestHash).toBe(entry.manifestHash);
      expect(manifest.productId).toBe(entry.productId);
    }
  });

  it("the California file equals the national file's CA rows, and annual rows are exact monthly sums", async () => {
    const byId = new Map((await catalogPromise).listings.map((l) => [l.id, l]));
    const national = await decodeRecords(byId.get("listing-national-monthly-2024-2026")!);
    const california = await decodeRecords(byId.get("listing-california-monthly-2024-2026")!);
    const strip = (r: DecodedRow) => `${r.period},${r.state},${r.brand},${r.units}`;
    expect(california.map(strip)).toEqual(national.filter((r) => r.state === "CA").map(strip));

    const annual = await decodeRecords(byId.get("listing-national-annual-2024-2026")!);
    for (const a of annual) {
      const sum = national.filter((r) => r.period.startsWith(a.period) && r.state === a.state && r.brand === a.brand).reduce((s, r) => s + r.units, 0);
      expect(a.units, `${a.period} ${a.state} ${a.brand}`).toBe(sum);
    }
    expect(annual.map((a) => a.period)).toEqual([...new Set(annual.map((a) => a.period))].flatMap((y) => Array(16).fill(y)));
  });

  it("the wrong-dates listing is older than the 2024 promise, so a promise complaint would be warranted", async () => {
    const byId = new Map((await catalogPromise).listings.map((l) => [l.id, l]));
    const stale = DatasetManifestSchema.parse(JSON.parse((await read(byId.get("listing-national-monthly-2021-2022")!.dataset.manifestJson)).toString("utf8")));
    const fresh = DatasetManifestSchema.parse(JSON.parse((await read(byId.get("listing-national-monthly-2024-2026")!.dataset.manifestJson)).toString("utf8")));
    expect(BigInt(stale.minTimestamp) < BigInt(fresh.minTimestamp)).toBe(true);
    expect(fresh.minTimestamp).toBe(publicationTimestamp("2024-01").toString()); // 2024-02-01T00:00:00Z
    expect(stale.minTimestamp).toBe(publicationTimestamp("2021-01").toString());
  });
});

describe("row generation", () => {
  it("is a pure function of (state, period, brand) with non-negative integer units", () => {
    expect(monthlyUnits("CA", "2024-01", "Voltara")).toBe(monthlyUnits("CA", "2024-01", "Voltara"));
    expect(monthlyUnits("CA", "2024-01", "Voltara")).not.toBe(monthlyUnits("CA", "2024-02", "Voltara"));
    const rows = buildRows({ granularity: "monthly", startMonth: "2021-01", endMonth: "2026-09", states: STATES });
    for (const r of rows) {
      expect(Number.isInteger(r.units)).toBe(true);
      expect(r.units).toBeGreaterThanOrEqual(0);
    }
    expect(monthsBetween("2024-11", "2025-02")).toEqual(["2024-11", "2024-12", "2025-01", "2025-02"]);
    expect(() => monthsBetween("2025-02", "2024-11")).toThrow();
    expect(publicationTimestamp("2024-12")).toBe(1735689600n); // 2025-01-01T00:00:00Z
  });
});
