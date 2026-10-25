// Regenerates data/ (SIMULATED datasets, manifests, catalog.json).
// Run: pnpm datasets:generate        Deterministic for a given SOURCE_SIGNER_KEY.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateDatasets, resolveSourceSignerKey, writeGenerated } from "../packages/datasets/src/index";

const repoRoot = resolve(import.meta.dirname, "..");

/** Minimal .env loader; never overrides variables already in the environment. */
function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv(resolve(repoRoot, ".env"));
const signer = resolveSourceSignerKey();
if (!signer.isDefault) {
  console.warn(
    "[datasets] SOURCE_SIGNER_KEY is set: records will be signed by " +
      `${signer.address}. The committed data uses the simulated default key, so the determinism test will fail until you commit the regenerated files.`,
  );
}

const started = Date.now();
const generated = await generateDatasets({ sourcePrivateKey: signer.privateKey, sourceAddress: signer.address });
const written = await writeGenerated(generated, resolve(repoRoot, "data"));

console.log(`[datasets] SIMULATED source signer ${signer.address}${signer.isDefault ? " (default)" : ""}`);
for (const d of generated.datasets) {
  console.log(`[datasets] ${d.spec.productId}: ${d.rows.length} rows, ${d.manifest.chunkCount} chunks, manifestHash ${d.manifest.manifestHash}`);
}
for (const l of generated.catalog.listings) console.log(`[catalog] ${l.id}: ${l.sellerId} ${l.license} ${l.priceAtomic} atomic`);
console.log(`[datasets] wrote ${written.length} files under data/ in ${Date.now() - started} ms`);
