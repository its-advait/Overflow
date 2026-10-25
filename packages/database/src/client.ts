import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export type Schema = typeof schema;
/** Driver-agnostic Drizzle handle every repository accepts. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type Executor = Db | Tx;

/**
 * "postgres": a real server via DATABASE_URL (postgres-js driver).
 * "pglite": in-process Postgres (WASM) used when no server is configured.
 * Both run the same schema and the same migration files.
 */
export type Dialect = "postgres" | "pglite";

export interface DatabaseOptions {
  /** Postgres connection string. Defaults to DATABASE_URL. */
  url?: string | undefined;
  /** PGlite data directory. Defaults to PGLITE_DATA_DIR; ":memory:" or unset means in-memory. */
  pgliteDataDir?: string | undefined;
  /** Where the SQL migrations live. Defaults to OVERFLOW_MIGRATIONS_DIR or <package>/drizzle. */
  migrationsFolder?: string | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface DatabaseHandle {
  db: Db;
  dialect: Dialect;
  /** Applies every pending migration from the package's drizzle/ folder. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Pure selection rule, exported so it can be tested without opening a database. */
export function selectDialect(opts: Pick<DatabaseOptions, "url" | "pgliteDataDir">): {
  dialect: Dialect;
  target: string;
} {
  const url = opts.url ?? process.env["DATABASE_URL"];
  if (url && url.length > 0) return { dialect: "postgres", target: redact(url) };
  const dir = opts.pgliteDataDir ?? process.env["PGLITE_DATA_DIR"];
  if (dir && dir.length > 0 && dir !== ":memory:") return { dialect: "pglite", target: dir };
  return { dialect: "pglite", target: ":memory:" };
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable url>";
  }
}

export async function createDatabase(opts: DatabaseOptions = {}): Promise<DatabaseHandle> {
  const migrationsFolder =
    opts.migrationsFolder ?? process.env["OVERFLOW_MIGRATIONS_DIR"] ?? DEFAULT_MIGRATIONS_FOLDER;
  const { dialect, target } = selectDialect(opts);
  opts.log?.(`[database] dialect=${dialect} target=${target}`);

  if (dialect === "postgres") {
    const url = opts.url ?? process.env["DATABASE_URL"] ?? "";
    const client = postgres(url, { max: 10, prepare: false });
    const db = drizzlePostgres(client, { schema });
    return {
      db: db as unknown as Db,
      dialect,
      migrate: () => migratePostgres(db, { migrationsFolder }),
      close: () => client.end(),
    };
  }

  const client = target === ":memory:" ? new PGlite() : new PGlite(target);
  const db = drizzlePglite(client, { schema });
  return {
    db: db as unknown as Db,
    dialect,
    migrate: () => migratePglite(db, { migrationsFolder }),
    close: () => client.close(),
  };
}
