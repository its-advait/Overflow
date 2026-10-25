import { createDatabase } from "../src/client";

// Applies drizzle/ migrations to DATABASE_URL, or to the PGlite directory in
// PGLITE_DATA_DIR when no server is configured.
const handle = await createDatabase({ log: console.log });
await handle.migrate();
console.log(`[database] migrations applied (dialect=${handle.dialect})`);
await handle.close();
