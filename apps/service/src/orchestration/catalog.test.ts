import { loadCatalog } from "@overflow/datasets";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../test-db.js";
import { seedCatalog } from "./catalog.js";

describe("seedCatalog (SIMULATED catalog -> resources)", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => {
    handle = await testDatabase();
  });
  afterAll(() => handle.close());

  it("inserts every listing once and is a no-op on the second run", async () => {
    const catalog = await loadCatalog();
    const first = await seedCatalog(handle.db);
    expect(first).toMatchObject({ total: catalog.listings.length, inserted: catalog.listings.length, existing: 0, simulated: true });
    expect(first.total).toBe(6);

    const second = await seedCatalog(handle.db);
    expect(second).toMatchObject({ total: 6, inserted: 0, existing: 6 });

    const rows = await handle.repos.resources.list();
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.id).sort()).toEqual(catalog.listings.map((l) => l.id).sort());
    expect(rows.every((r) => r.simulated)).toBe(true);
    for (const row of rows) {
      const entry = catalog.listings.find((l) => l.id === row.id)!;
      expect(row).toMatchObject({
        title: entry.title,
        sellerId: entry.sellerId,
        productId: entry.productId,
        coverage: entry.coverage,
        license: entry.license,
        priceAtomic: entry.priceAtomic,
        manifestHash: entry.manifestHash,
        seats: entry.seats,
      });
    }
    // Three listings deliberately share the national manifestHash (duplicate seller, single-user variant).
    const national = rows.find((r) => r.id === "listing-national-monthly-2024-2026")!;
    expect(rows.filter((r) => r.manifestHash === national.manifestHash)).toHaveLength(3);
  });

  it("fails loudly when the catalog file is missing", async () => {
    await expect(seedCatalog(handle.db, { path: "/nonexistent/catalog.json" })).rejects.toThrow(/catalog file not found/);
  });
});
