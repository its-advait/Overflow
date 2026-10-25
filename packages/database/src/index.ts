export const PACKAGE_NAME = "@overflow/database" as const;

export * as schema from "./schema";
export { TABLE_NAMES } from "./schema";
export {
  createDatabase,
  selectDialect,
  DEFAULT_MIGRATIONS_FOLDER,
  type DatabaseHandle,
  type DatabaseOptions,
  type Db,
  type Dialect,
  type Executor,
  type Tx,
} from "./client";
export * from "./errors";
export * from "./repositories";
export { seed, DEFAULT_COMPANY_NAME, SEED_DEPARTMENTS, SEED_ORGANIZATION_ID, type SeedOptions, type SeedResult } from "./seed";
