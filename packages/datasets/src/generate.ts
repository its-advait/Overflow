import type { Address, Hex } from "viem";
import {
  RECORD_FORMAT,
  buildRecordChunk,
  buildTree,
  computeManifestHash,
  hashLeaf,
  joinChunks,
  type DatasetManifest,
  DatasetManifestSchema,
} from "@overflow/recourse-crypto";
import { CATALOG_RELATIVE_PATH, CATALOG_VERSION, serializeCatalog, type CatalogEntry, type CatalogFile } from "./catalog";
import { CATALOG_AS_OF, DATASETS, DATASETS_DIR, LISTINGS, SELLERS, coverageFor, datasetSpec, priceAtomicFor, type DatasetSpec } from "./listings";
import { buildRows, fieldsFor, formatRow, headerFor, publicationTimestamp, type DataRow } from "./rows";
import { SIMULATED_SOURCE_SIGNER_KEY, SOURCE_SIGNER_LABEL } from "./signer";

// ---------------------------------------------------------------------------
// Generator: rows -> signed 160-byte records -> plain Merkle root -> manifest
// -> catalog. Everything is in memory; writeGenerated() puts it under data/.
// Deterministic for a given source key (RFC 6979 signatures).
// ---------------------------------------------------------------------------

export const GENERATOR_NAME = "scripts/generate-datasets.mts";

export interface GeneratedDataset {
  spec: DatasetSpec;
  rows: DataRow[];
  header: string;
  fields: string[];
  csv: string;
  chunks: Uint8Array[];
  records: Uint8Array;
  manifest: DatasetManifest;
  /** Relative to data/. */
  paths: { dir: string; rowsCsv: string; recordsBin: string; manifestJson: string };
}

export interface Generated {
  datasets: GeneratedDataset[];
  catalog: CatalogFile;
  /** Every output file, keyed by path relative to data/. */
  files: Map<string, string | Uint8Array>;
}

export interface GenerateOptions {
  sourcePrivateKey?: Hex;
  sourceAddress: Address;
}

export function serializeManifest(manifest: DatasetManifest): string {
  return `${JSON.stringify(DatasetManifestSchema.parse(manifest), null, 2)}\n`;
}

export async function generateDataset(spec: DatasetSpec, sourcePrivateKey: Hex, sourceAddress: Address): Promise<GeneratedDataset> {
  const rows = buildRows(spec.rows);
  const header = headerFor(spec.rows.granularity);
  const fields = fieldsFor(spec.rows.granularity);
  const lines = rows.map(formatRow);
  const csv = `${[header, ...lines].join("\n")}\n`;
  const chunks = await Promise.all(
    rows.map((row, i) => buildRecordChunk({ row: lines[i] as string, timestamp: publicationTimestamp(row.lastMonth) }, sourcePrivateKey)),
  );
  const plainLeaves = chunks.map(hashLeaf);
  const rootPlain = buildTree(plainLeaves).root;
  const minTimestamp = rows.reduce((min, r) => {
    const t = publicationTimestamp(r.lastMonth);
    return t < min ? t : min;
  }, publicationTimestamp((rows[0] as DataRow).lastMonth));
  const hashInput = { rootPlain, chunkCount: chunks.length, sourceKey: sourceAddress, minTimestamp: minTimestamp.toString(), header };
  const manifest = DatasetManifestSchema.parse({
    simulated: true,
    productId: spec.productId,
    title: spec.title,
    header,
    fields,
    granularity: spec.rows.granularity,
    chunkCount: chunks.length,
    rootPlain,
    plainLeaves,
    sourceKey: sourceAddress,
    minTimestamp: minTimestamp.toString(),
    manifestHash: computeManifestHash(hashInput),
    recordFormat: RECORD_FORMAT,
  } satisfies DatasetManifest);
  const dir = `${DATASETS_DIR}/${spec.productId}`;
  return {
    spec,
    rows,
    header,
    fields,
    csv,
    chunks,
    records: joinChunks(chunks),
    manifest,
    paths: { dir, rowsCsv: `${dir}/rows.csv`, recordsBin: `${dir}/records.bin`, manifestJson: `${dir}/manifest.json` },
  };
}

export async function generateDatasets(opts: GenerateOptions): Promise<Generated> {
  const privateKey = opts.sourcePrivateKey ?? SIMULATED_SOURCE_SIGNER_KEY;
  const datasets: GeneratedDataset[] = [];
  for (const spec of DATASETS) datasets.push(await generateDataset(spec, privateKey, opts.sourceAddress));
  const byProduct = new Map(datasets.map((d) => [d.spec.productId, d]));

  const listings: CatalogEntry[] = LISTINGS.map((l) => {
    const d = byProduct.get(l.productId);
    if (!d) throw new Error(`listing ${l.id} names unknown dataset ${l.productId}`);
    return {
      id: l.id,
      title: l.title,
      sellerId: l.sellerId,
      productId: l.productId,
      coverage: coverageFor(datasetSpec(l.productId), d.fields),
      license: l.license,
      seats: l.seats,
      priceAtomic: priceAtomicFor(l),
      manifestHash: d.manifest.manifestHash,
      simulated: true,
      exercises: l.exercises,
      dataset: { ...d.paths, rowCount: d.rows.length, chunkCount: d.manifest.chunkCount },
    };
  });

  const catalog: CatalogFile = {
    version: CATALOG_VERSION,
    simulated: true,
    description:
      "SIMULATED seller catalog for the Overflow demo. Every dataset is synthetic, redistributable EV-registration data signed by a simulated state registry feed; no seller, brand or number is real.",
    generator: GENERATOR_NAME,
    generatedFor: { asOf: CATALOG_AS_OF },
    sourceSigner: { label: SOURCE_SIGNER_LABEL, address: opts.sourceAddress },
    sellers: Object.values(SELLERS).map((s) => ({ id: s.id, name: s.name, simulated: true })),
    regionCodes: "ISO 3166-2 style: US = national aggregate claim, US-<state> = state detail present in the rows",
    listings,
  };

  const files = new Map<string, string | Uint8Array>();
  for (const d of datasets) {
    files.set(d.paths.rowsCsv, d.csv);
    files.set(d.paths.recordsBin, d.records);
    files.set(d.paths.manifestJson, serializeManifest(d.manifest));
  }
  files.set(CATALOG_RELATIVE_PATH.replace(/^data\//, ""), serializeCatalog(catalog));
  return { datasets, catalog, files };
}

/** Writes every generated file under `dataDir` (the repo's data/ folder). Returns the paths written. */
export async function writeGenerated(generated: Generated, dataDir: string): Promise<string[]> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname, resolve } = await import("node:path");
  const written: string[] = [];
  for (const [rel, content] of generated.files) {
    const target = resolve(dataDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    written.push(target);
  }
  return written;
}
