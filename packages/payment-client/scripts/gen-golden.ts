// Writes test/golden.json and copies it to contracts/test/fixtures/payment-client-golden.json.
// Deterministic (RFC 6979 signatures): running twice yields identical files (golden.test.ts checks).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  GOLDEN_FIXTURE_RELATIVE_PATH,
  GOLDEN_VECTOR_RELATIVE_PATH,
  generateGoldenVector,
  serializeGoldenVector,
} from "../src/golden";

const packageRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageRoot, "../..");

const json = serializeGoldenVector(await generateGoldenVector());
for (const target of [resolve(packageRoot, GOLDEN_VECTOR_RELATIVE_PATH), resolve(repoRoot, GOLDEN_FIXTURE_RELATIVE_PATH)]) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, json, "utf8");
  console.log(`wrote ${target}`);
}
