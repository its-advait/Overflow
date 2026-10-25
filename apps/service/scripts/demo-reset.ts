/**
 * Demo reset. Reuses the deployed contracts (never deploys).
 *   pnpm demo:reset [--behavior honest|swap|ghost]
 *
 * With the service RUNNING (SERVICE_URL answers):
 *   - sets both SIMULATED Recourse sellers to --behavior (default honest) via PUT {SELLER_URL}/sellers/:id/behavior.
 *   The database and reservations are NOT touched while the service runs (PGlite is single-process).
 * With the service STOPPED:
 *   - stale reservations: every `active` reservation in the old database whose validBefore has passed is printed with
 *     the exact `POST /release` command to run once the service is up (the relayer then submits treasury.release(digest));
 *   - fresh database: the PGlite directory (PGLITE_DATA_DIR) is MOVED aside to <dir>.bak-<timestamp> (never deleted),
 *     then migrated and seeded: the SIMULATED company, its agents (created if missing) and the SIMULATED catalog.
 *   - Postgres (DATABASE_URL) is refused: drop that database yourself.
 *   Then start the service and run demo:reset again to set behaviors (they are in-memory in the seller service).
 */
import { existsSync, renameSync } from "node:fs";
import { createDatabase, createRepositories, seed } from "@overflow/database";
import { loadEnv } from "../src/config.js";
import { seedCatalog } from "../src/orchestration/catalog.js";

const BEHAVIORS = ["honest", "swap", "ghost"] as const;
const SELLERS = ["sim-seller-a", "sim-seller-b"] as const;

async function up(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  loadEnv();
  const args = process.argv.slice(2);
  const i = args.indexOf("--behavior");
  const behavior = (i >= 0 ? args[i + 1] : "honest") as (typeof BEHAVIORS)[number];
  if (!BEHAVIORS.includes(behavior)) throw new Error(`--behavior must be one of ${BEHAVIORS.join("|")}`);
  const service = (process.env["SERVICE_URL"] || "http://localhost:4000").replace(/\/$/, "");
  const seller = (process.env["SELLER_URL"] || "http://localhost:4100").replace(/\/$/, "");
  let failures = 0;

  if (await up(`${service}/`)) {
    console.log(`[reset] service is running at ${service}: setting seller behaviors; database and reservations untouched`);
    const r = await fetch(`${service}/`).then((x) => x.json() as Promise<Record<string, unknown>>);
    console.log(`[reset] database: ${JSON.stringify((r["database"] as Record<string, unknown> | undefined)?.["dialect"] ?? "unknown")} (reset it with the service stopped)`);
    for (const id of SELLERS) {
      const res = await fetch(`${seller}/sellers/${id}/behavior`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ behavior }) }).catch((e: unknown) => e);
      if (res instanceof Response && res.status === 200) {
        const body = (await res.json()) as { behavior?: string; sellerAddress?: string };
        console.log(`[reset] [SIMULATED] ${id} (${body.sellerAddress ?? "?"}) behavior -> ${body.behavior}`);
      } else {
        failures++;
        console.log(`[reset] ${id} behavior not set: ${res instanceof Response ? `HTTP ${res.status}` : String(res)}`);
      }
    }
    console.log("[reset] stale reservations: TODO (no API route lists reservations while the service holds the PGlite lock); run demo:reset with the service stopped to release them from the database records");
    return failures ? 1 : 0;
  }

  console.log(`[reset] service not running at ${service}: resetting the database`);
  if (process.env["DATABASE_URL"]) throw new Error("DATABASE_URL is set: demo:reset only resets PGlite; drop the Postgres database yourself");
  const dir = process.env["PGLITE_DATA_DIR"];

  // Stale reservations recorded in the old database: list them so the operator can release them once the service runs.
  if (dir && dir !== ":memory:" && existsSync(dir)) {
    const old = await createDatabase({ log: () => undefined });
    await old.migrate();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const stale = (await createRepositories(old.db).reservations.listActive()).filter((x) => BigInt(x.validBefore) < now);
    await old.close();
    if (stale.length === 0) console.log("[reset] no stale active reservations in the old database");
    for (const s of stale) console.log(`[reset] STALE reservation ${s.digest} (validBefore ${s.validBefore}): after the service starts, run: curl -X POST ${service}/release -H 'content-type: application/json' -d '{"digest":"${s.digest}"}'`);
    const backup = `${dir}.bak-${Date.now()}`;
    renameSync(dir, backup);
    console.log(`[reset] moved the old PGlite directory aside to ${backup} (not deleted)`);
  } else if (!dir || dir === ":memory:") {
    console.log("[reset] PGLITE_DATA_DIR is unset or :memory: — every service start already uses a fresh in-memory database");
  } else {
    console.log(`[reset] ${dir} does not exist yet: creating it fresh`);
  }

  const db = await createDatabase({ log: () => undefined });
  await db.migrate();
  const seeded = await seed(db.db);
  const catalog = await seedCatalog(db.db);
  await db.close();
  console.log(`[reset] fresh database: organization "${seeded.organization.name}" (SIMULATED), ${seeded.agents.length} agents; SIMULATED catalog ${catalog.total} listings`);
  console.log(`[reset] next: start the service (pnpm --filter @overflow/service dev), then pnpm demo:reset --behavior ${behavior} to set the SIMULATED sellers, then pnpm demo:preflight`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`[demo-reset] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
