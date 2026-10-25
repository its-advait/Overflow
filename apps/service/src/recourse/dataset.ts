import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadCatalog, type CatalogEntry } from "@overflow/datasets";
import { buildTree, DatasetManifestSchema, hashLeaf, splitDataset, verifyManifest, type DatasetManifest, type MerkleTree } from "@overflow/recourse-crypto";
import type { Hex } from "@overflow/schemas";
import { repoRoot } from "../config.js";

// ---------------------------------------------------------------------------
// A SIMULATED catalog listing's dataset as the seller holds it: the manifest
// (what the buyer sees before paying) and the 160-byte records (what the
// buyer gets after the key reveal). Both are checked against each other here,
// so a seller that lies about its own data fails before any order exists.
// ---------------------------------------------------------------------------

export interface LoadedDataset {
  listing: CatalogEntry;
  manifest: DatasetManifest;
  plainChunks: Uint8Array[];
  plainLeaves: Hex[];
  plainTree: MerkleTree;
}

export async function loadListingDataset(listingId: string, catalogPath?: string): Promise<LoadedDataset> {
  const catalog = await loadCatalog(catalogPath);
  const listing = catalog.listings.find((l) => l.id === listingId);
  if (!listing) throw new Error(`catalog has no listing ${listingId}`);
  const dataDir = catalogPath ? dirname(catalogPath) : resolve(repoRoot(), "data");
  const manifestJson = JSON.parse(await readFile(resolve(dataDir, listing.dataset.manifestJson), "utf8")) as unknown;
  const verdict = verifyManifest(manifestJson);
  if (!verdict.ok) throw new Error(`manifest for ${listingId} is invalid: ${verdict.reason}: ${verdict.detail}`);
  const manifest = DatasetManifestSchema.parse(manifestJson);
  const records = new Uint8Array(await readFile(resolve(dataDir, listing.dataset.recordsBin)));
  const plainChunks = splitDataset(records);
  if (plainChunks.length !== manifest.chunkCount) throw new Error(`${listingId}: records.bin has ${plainChunks.length} chunks, manifest says ${manifest.chunkCount}`);
  const plainLeaves = plainChunks.map(hashLeaf);
  for (let i = 0; i < plainLeaves.length; i++) {
    if (plainLeaves[i]!.toLowerCase() !== manifest.plainLeaves[i]!.toLowerCase()) throw new Error(`${listingId}: chunk ${i} does not hash to the manifest's plain leaf`);
  }
  const plainTree = buildTree(plainLeaves);
  if (plainTree.root !== manifest.rootPlain.toLowerCase()) throw new Error(`${listingId}: records Merkle to ${plainTree.root}, manifest says ${manifest.rootPlain}`);
  if (listing.manifestHash.toLowerCase() !== manifest.manifestHash.toLowerCase()) throw new Error(`${listingId}: catalog manifestHash differs from the manifest's`);
  return { listing, manifest, plainChunks, plainLeaves, plainTree };
}
