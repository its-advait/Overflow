import { AddressSchema, IdSchema, ResourceListingSchema } from "@overflow/schemas";
import { z } from "zod";

// ---------------------------------------------------------------------------
// data/catalog.json: the SIMULATED seller catalog Oracle discovers from.
// Every entry is a ResourceListing (packages/schemas) plus the fields a
// `resources` row needs (id, title) and where its files live.
// ---------------------------------------------------------------------------

export const CATALOG_VERSION = 1;
export const CATALOG_RELATIVE_PATH = "data/catalog.json";

export const CatalogDatasetFilesSchema = z.object({
  /** Directory under data/, e.g. "datasets/ev-registrations-national-monthly-2024-2026". */
  dir: z.string().min(1),
  rowsCsv: z.string().min(1),
  recordsBin: z.string().min(1),
  manifestJson: z.string().min(1),
  rowCount: z.number().int().positive(),
  chunkCount: z.number().int().positive(),
});

export const CatalogEntrySchema = ResourceListingSchema.extend({
  id: IdSchema,
  title: z.string().min(1),
  /** Always true here; the schema default (false) is not acceptable for catalog data. */
  simulated: z.literal(true),
  /** Why the listing is in the demo catalog (which rule it exercises). */
  exercises: z.string().min(1),
  dataset: CatalogDatasetFilesSchema,
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const CatalogFileSchema = z.object({
  version: z.literal(CATALOG_VERSION),
  simulated: z.literal(true),
  description: z.string().min(1),
  generator: z.string().min(1),
  generatedFor: z.object({ asOf: z.iso.date() }),
  sourceSigner: z.object({ label: z.string().min(1), address: AddressSchema }),
  sellers: z.array(z.object({ id: IdSchema, name: z.string().min(1), simulated: z.literal(true) })).min(1),
  regionCodes: z.string().min(1),
  listings: z.array(CatalogEntrySchema).min(1),
});
export type CatalogFile = z.infer<typeof CatalogFileSchema>;

export function parseCatalog(json: string): CatalogFile {
  return CatalogFileSchema.parse(JSON.parse(json));
}

/** Canonical serialization; the determinism test compares this byte for byte. */
export function serializeCatalog(catalog: CatalogFile): string {
  return `${JSON.stringify(CatalogFileSchema.parse(catalog), null, 2)}\n`;
}

/**
 * Loads <repo>/data/catalog.json (override with OVERFLOW_CATALOG_PATH). Dynamic
 * node imports keep this module importable from browser bundles.
 */
export async function loadCatalog(path?: string): Promise<CatalogFile> {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const target = path ?? globalThis.process?.env?.["OVERFLOW_CATALOG_PATH"] ?? resolve(import.meta.dirname, "../../..", CATALOG_RELATIVE_PATH);
  let json: string;
  try {
    json = await readFile(target, "utf8");
  } catch (e) {
    throw new Error(`catalog file not found at ${target} (run pnpm datasets:generate): ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseCatalog(json);
}
