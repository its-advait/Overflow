import { createServer } from "node:http";
import { createDatabase } from "@overflow/database";
import { CHAIN_ID, PACKAGE_NAME as SCHEMAS } from "@overflow/schemas";
import { API_STATUS } from "./api/index.js";
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

const status = {
  service: "@overflow/service",
  scaffold: true,
  chainId: CHAIN_ID,
  database: {
    dialect: database.dialect,
    migrationsFolder: database.migrationsFolder,
    migrated: true,
  },
  modules: {
    api: API_STATUS,
    orchestration: ORCHESTRATION_STATUS,
    facilitator: FACILITATOR_STATUS,
    sellers: SELLERS_STATUS,
    chain: CHAIN_STATUS,
  },
  dependsOn: [SCHEMAS],
};

const server = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(status));
});

server.listen(port, () => {
  console.log(`[scaffold] @overflow/service listening on http://localhost:${port}`);
});

const shutdown = (): void => {
  server.close(() => {
    void database.close().finally(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
