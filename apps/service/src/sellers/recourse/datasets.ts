import { loadCatalog, type CatalogEntry, type CatalogFile } from "@overflow/datasets";
import { buildTree, DatasetManifestSchema, hashLeaf, splitDataset, type DatasetManifest } from "@overflow/recourse-crypto";
import type { Hex } from "@overflow/schemas";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// SIMULATED datasets the Recourse sellers deliver: the catalog listings joined
// with their verified manifest + plaintext chunks. Loading REFUSES any dataset
// whose manifest, chunk count, leaves or plaintext root disagree, so a seller
// can never commit to terms its own files do not back.
// ---------------------------------------------------------------------------

export interface RecourseListing extends CatalogEntry {
  manifest: DatasetManifest;
  plainChunks: Uint8Array[];
  plainLeaves: Hex[];
}

export interface RecourseCatalog {
  listings: Map<string, RecourseListing>;
  sellers: CatalogFile["sellers"];
  catalog: CatalogFile;
  dataDir: string;
}

export class DatasetIntegrityError extends Error {
  constructor(
    public readonly listingId: string,
    message: string,
  ) {
    super(`dataset for ${listingId}: ${message}`);
    this.name = "DatasetIntegrityError";
  }
}

export function defaultCatalogPath(): string {
  return process.env["OVERFLOW_CATALOG_PATH"] ?? resolve(import.meta.dirname, "../../../../../data/catalog.json");
}

type LoadedDataset = { manifest: DatasetManifest; plainChunks: Uint8Array[]; plainLeaves: Hex[] };
const datasetCache = new Map<string, Promise<LoadedDataset>>();

async function loadDataset(dataDir: string, entry: CatalogEntry): Promise<LoadedDataset> {
  const manifestPath = resolve(dataDir, entry.dataset.manifestJson);
  const recordsPath = resolve(dataDir, entry.dataset.recordsBin);
  const manifest = DatasetManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const plainChunks = splitDataset(new Uint8Array(await readFile(recordsPath)));
  if (manifest.chunkCount !== plainChunks.length) {
    throw new DatasetIntegrityError(entry.id, `records.bin holds ${plainChunks.length} chunks, manifest says ${manifest.chunkCount}`);
  }
  const plainLeaves = manifest.plainLeaves as Hex[];
  for (let i = 0; i < plainChunks.length; i++) {
    if (hashLeaf(plainChunks[i]!).toLowerCase() !== plainLeaves[i]!.toLowerCase()) {
      throw new DatasetIntegrityError(entry.id, `plain leaf ${i} does not hash the records.bin chunk`);
    }
  }
  if (buildTree(plainLeaves).root.toLowerCase() !== manifest.rootPlain.toLowerCase()) {
    throw new DatasetIntegrityError(entry.id, "plainLeaves do not build manifest.rootPlain");
  }
  return { manifest, plainChunks, plainLeaves };
}

export async function loadRecourseCatalog(opts: { catalogPath?: string; dataDir?: string } = {}): Promise<RecourseCatalog> {
  const catalogPath = opts.catalogPath ?? defaultCatalogPath();
  const dataDir = opts.dataDir ?? dirname(catalogPath);
  const catalog = await loadCatalog(catalogPath);
  const listings = new Map<string, RecourseListing>();
  for (const entry of catalog.listings) {
    const cacheKey = resolve(dataDir, entry.dataset.dir);
    let loading = datasetCache.get(cacheKey);
    if (!loading) {
      loading = loadDataset(dataDir, entry);
      datasetCache.set(cacheKey, loading);
      loading.catch(() => datasetCache.delete(cacheKey));
    }
    const ds = await loading;
    if (ds.manifest.manifestHash.toLowerCase() !== entry.manifestHash.toLowerCase()) {
      throw new DatasetIntegrityError(entry.id, `manifest.manifestHash ${ds.manifest.manifestHash} != listing.manifestHash ${entry.manifestHash}`);
    }
    if (ds.manifest.chunkCount !== entry.dataset.chunkCount) {
      throw new DatasetIntegrityError(entry.id, `manifest.chunkCount ${ds.manifest.chunkCount} != listing chunkCount ${entry.dataset.chunkCount}`);
    }
    listings.set(entry.id, { ...entry, ...ds });
  }
  return { listings, sellers: catalog.sellers, catalog, dataDir };
}
