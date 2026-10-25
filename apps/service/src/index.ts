import { serve } from "@hono/node-server";
import { createDatabase, seed } from "@overflow/database";
import { createApp } from "./api/index.js";
import { CHAIN_STATUS } from "./chain/index.js";
import { FACILITATOR_STATUS } from "./facilitator/index.js";
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

const { app } = createApp({
  db: database.db,
  status: {
    database: { dialect: database.dialect, migrationsFolder: database.migrationsFolder, migrated: true },
    modules: {
      api: "ready",
      orchestration: ORCHESTRATION_STATUS,
      facilitator: FACILITATOR_STATUS,
      sellers: SELLERS_STATUS,
      chain: CHAIN_STATUS,
    },
  },
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] @overflow/service listening on http://localhost:${info.port}`);
});

const shutdown = (): void => {
  server.close(() => {
    void database.close().finally(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
