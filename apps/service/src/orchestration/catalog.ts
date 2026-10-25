import { createRepositories, type Db } from "@overflow/database";
import { CATALOG_RELATIVE_PATH, loadCatalog } from "@overflow/datasets";

// ---------------------------------------------------------------------------
// Boot-time seed of the SIMULATED seller catalog (data/catalog.json) into the
// `resources` table. Idempotent: every listing id is inserted once and left
// alone afterwards (insert-if-missing), so a restart never duplicates or
// rewrites a row. Every row keeps simulated = true from the catalog.
// ---------------------------------------------------------------------------

export interface SeedCatalogResult {
  total: number;
  inserted: number;
  existing: number;
  /** Where the catalog was read from (explicit path, OVERFLOW_CATALOG_PATH, or the repo default). */
  catalogPath: string;
  simulated: true;
}

export async function seedCatalog(db: Db, opts: { path?: string | undefined } = {}): Promise<SeedCatalogResult> {
  const catalog = await loadCatalog(opts.path);
  const catalogPath = opts.path ?? process.env["OVERFLOW_CATALOG_PATH"] ?? `<repo>/${CATALOG_RELATIVE_PATH}`;
  const repos = createRepositories(db);
  // A fixed createdAt (the catalog's as-of day) keeps list() order stable across boots.
  const createdAt = `${catalog.generatedFor.asOf}T00:00:00.000Z`;
  let inserted = 0;
  let existing = 0;
  for (const listing of catalog.listings) {
    if (await repos.resources.getById(listing.id)) {
      existing++;
      continue;
    }
    await repos.resources.upsertById({
      id: listing.id,
      title: listing.title,
      sellerId: listing.sellerId,
      productId: listing.productId,
      coverage: listing.coverage,
      license: listing.license,
      priceAtomic: listing.priceAtomic,
      manifestHash: listing.manifestHash,
      seats: listing.seats,
      simulated: true,
      createdAt,
    });
    inserted++;
  }
  return { total: catalog.listings.length, inserted, existing, catalogPath, simulated: true };
}
