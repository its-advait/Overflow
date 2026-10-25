// Writes test/vectors.json and copies it to contracts/test/fixtures/recourse-vectors.json.
// Deterministic: running twice yields identical files (see vectors.test.ts).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { FIXTURE_RELATIVE_PATH, VECTORS_RELATIVE_PATH, generateGoldenVectors, serializeGoldenVectors } from "../src/vectors";

const packageRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageRoot, "../..");

const json = serializeGoldenVectors(await generateGoldenVectors());
const targets = [resolve(packageRoot, VECTORS_RELATIVE_PATH), resolve(repoRoot, FIXTURE_RELATIVE_PATH)];
for (const target of targets) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, json, "utf8");
  console.log(`wrote ${target}`);
}
