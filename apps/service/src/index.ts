import { serve } from "@hono/node-server";
import { createDatabase, seed } from "@overflow/database";
import { createApp } from "./api/index.js";
import { createActivityBus, createIndexer, createLogSource, resolveIndexerConfig, type Indexer } from "./chain/index.js";
import { FACILITATOR_STATUS } from "./facilitator/index.js";
import { createReconciliation, LEDGER_STATUS, type Reconciliation } from "./ledger/index.js";
import { ORCHESTRATION_STATUS } from "./orchestration/index.js";
import { SELLERS_STATUS } from "./sellers/index.js";

const port = Number(new URL(process.env["SERVICE_URL"] ?? "http://localhost:4000").port || 4000);

// Open the database and apply pending migrations before accepting requests.
// DATABASE_URL selects Postgres; otherwise PGlite at PGLITE_DATA_DIR (or in-memory).
const database = await createDatabase({ log: console.log });
await database.migrate();
console.log(`[database] migrations applied (dialect=${database.dialect}, from ${database.migrationsFolder})`);

// Idempotent seed of the SIMULATED demo company and its three agents (placeholder keys).
const seeded = await seed(database.db);
console.log(
  `[seed] organization "${seeded.organization.name}" (SIMULATED) agents=${seeded.agents.length}`,
);

// Chain indexer: runs only with BASE_SEPOLIA_RPC_URL and a deployments file.
// Otherwise it stays idle and says why; no address or block is ever invented.
const bus = createActivityBus();
const indexerConfig = await resolveIndexerConfig();
let indexer: Indexer | undefined;
let reconciliation: Reconciliation | undefined;
let chainStatus: string;
let ledgerStatus: string = LEDGER_STATUS;
if (indexerConfig.ok) {
  const { config } = indexerConfig;
  const source = createLogSource(config.rpcUrl);
  await source.assertChain();
  // Reconciliation reads balances at the indexer's cursor after every poll that stored new logs.
  const materiality = process.env["RECONCILIATION_MATERIALITY_ATOMIC"];
  const recon = createReconciliation({
    db: database.db,
    reader: source,
    treasury: config.treasury,
    usdc: config.usdc,
    bus,
    ...(materiality ? { materialityAtomic: BigInt(materiality) } : {}),
  });
  reconciliation = recon;
  indexer = createIndexer({
    db: database.db,
    source,
    config,
    bus,
    afterTick: async (r) => {
      if (r.logsInserted > 0) await recon.run("indexer", r.toBlock);
    },
  });
  chainStatus = `indexing treasury ${config.treasury} from block ${config.deployBlock}`;
  ledgerStatus = `journal posted from chain events; reconciliation after every poll with new logs (materiality ${materiality ?? "10000"} atomic)`;
} else {
  chainStatus = `idle: ${indexerConfig.reason}`;
  console.warn(`[chain] indexer idle: ${indexerConfig.reason}`);
}

const { app } = createApp({
  db: database.db,
  bus,
  ...(reconciliation ? { ports: { reconciliation: { run: (trigger) => reconciliation!.run(trigger) } } } : {}),
  ...(indexerConfig.ok ? { treasury: indexerConfig.config.treasury } : {}),
  indexerStatus: () => indexer?.status() ?? { state: "idle", reason: indexerConfig.ok ? "not started" : indexerConfig.reason },
  status: {
    database: { dialect: database.dialect, migrationsFolder: database.migrationsFolder, migrated: true },
    modules: {
      api: "ready",
      orchestration: ORCHESTRATION_STATUS,
      facilitator: FACILITATOR_STATUS,
      sellers: SELLERS_STATUS,
      chain: chainStatus,
      ledger: ledgerStatus,
      exceptions: indexerConfig.ok
        ? `controller requests target treasury ${indexerConfig.config.treasury}; done only on indexed AllowSet/CapRaised/NodePaused`
        : "offchain exceptions only: no treasury address (onchain requests answer 501 until a deployments file exists)",
    },
  },
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] @overflow/service listening on http://localhost:${info.port}`);
});
await indexer?.start();

const shutdown = (): void => {
  server.close(() => {
    void (indexer ? indexer.stop() : Promise.resolve())
      .then(() => database.close())
      .finally(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
