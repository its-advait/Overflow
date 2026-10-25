import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectDialect } from "./client";
import { TABLE_NAMES } from "./schema";
import { freshDatabase, queryRows } from "./test-helpers";

describe("migrations on a fresh database", () => {
  let handle: Awaited<ReturnType<typeof freshDatabase>>;
  beforeAll(async () => {
    handle = await freshDatabase();
  });
  afterAll(() => handle.close());

  it("runs with the pglite dialect when no DATABASE_URL is given", () => {
    expect(handle.dialect).toBe("pglite");
  });

  it("creates all 21 tables", async () => {
    const rows = await queryRows<{ table_name: string }>(
      handle.db,
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of TABLE_NAMES) expect(names.has(t), t).toBe(true);
    expect(TABLE_NAMES.length).toBe(21);
  });

  it("stores every money column as numeric(78,0) and uses no float types anywhere", async () => {
    const rows = await queryRows<{
      table_name: string;
      column_name: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      handle.db,
      sql`SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
          FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const floats = rows.filter((r) => ["real", "double precision"].includes(r.data_type));
    expect(floats).toEqual([]);
    const money = rows.filter((r) =>
      ["budget", "price", "max_price", "amount", "bond", "value"].includes(r.column_name),
    );
    expect(money.length).toBeGreaterThanOrEqual(9);
    for (const m of money) {
      expect(m.data_type, `${m.table_name}.${m.column_name}`).toBe("numeric");
      expect(Number(m.numeric_precision)).toBe(78);
      expect(Number(m.numeric_scale)).toBe(0);
    }
  });

  it("has the three required unique constraints and the partial active-purchase index", async () => {
    const cons = await queryRows<{ conname: string }>(
      handle.db,
      sql`SELECT conname FROM pg_constraint WHERE contype = 'u'`,
    );
    const names = cons.map((r) => r.conname);
    expect(names).toContain("purchases_idempotency_key_unique");
    expect(names).toContain("chain_transactions_tx_hash_log_index_unique");
    expect(names).toContain("financial_entries_source_event_id_unique");

    const idx = await queryRows<{ indexdef: string }>(
      handle.db,
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'purchases_active_mission_resource_uidx'`,
    );
    const def = idx[0]?.indexdef ?? "";
    expect(def).toMatch(/UNIQUE INDEX/);
    expect(def).toMatch(/WHERE/);
    for (const s of ["SETTLED", "REFUNDED", "REJECTED", "FAILED_BEFORE_FUNDING", "RELEASED"]) {
      expect(def).toContain(s);
    }
  });

  it("applying migrations twice is a no-op", async () => {
    await expect(handle.migrate()).resolves.toBeUndefined();
  });
});

describe("selectDialect", () => {
  it("prefers a Postgres URL, then a PGlite directory, then in-memory PGlite", () => {
    expect(selectDialect({ url: "postgres://u:secret@h:5432/db" })).toEqual({
      dialect: "postgres",
      target: "postgres://u:***@h:5432/db",
    });
    expect(selectDialect({ url: "", pgliteDataDir: "/tmp/x" })).toEqual({ dialect: "pglite", target: "/tmp/x" });
    expect(selectDialect({ url: "", pgliteDataDir: ":memory:" })).toEqual({ dialect: "pglite", target: ":memory:" });
  });
});
