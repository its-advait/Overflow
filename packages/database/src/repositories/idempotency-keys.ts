import { IdempotencyRecordSchema, type IdempotencyRecord } from "@overflow/schemas";
import { eq } from "drizzle-orm";
import type { Executor } from "../client";
import { NotFoundError, withDbErrors } from "../errors";
import { idempotencyKeys } from "../schema";
import { iso, nowIso, parseOne, type WithOptional } from "./base";

export type IdempotencyInsert = WithOptional<IdempotencyRecord, "createdAt">;

const toRecord = (r: typeof idempotencyKeys.$inferSelect): IdempotencyRecord =>
  parseOne(IdempotencyRecordSchema, {
    key: r.key,
    scope: r.scope,
    requestHash: r.requestHash,
    statusCode: r.statusCode,
    response: r.response,
    createdAt: iso(r.createdAt),
  });

export function idempotencyKeysRepository(db: Executor) {
  return {
    async get(key: string): Promise<IdempotencyRecord | undefined> {
      const [r] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
      return r ? toRecord(r) : undefined;
    },

    /**
     * Stores a result once. If another writer stored the same key first, that
     * row is returned unchanged with `inserted: false` (the first result wins;
     * the caller compares requestHash and replays or refuses).
     */
    async put(input: IdempotencyInsert): Promise<{ inserted: boolean; row: IdempotencyRecord }> {
      const row = IdempotencyRecordSchema.parse({ ...input, createdAt: input.createdAt ?? nowIso() });
      const returned = await withDbErrors(() =>
        db
          .insert(idempotencyKeys)
          .values({
            key: row.key,
            scope: row.scope,
            requestHash: row.requestHash,
            statusCode: row.statusCode,
            response: row.response,
            createdAt: new Date(row.createdAt),
          })
          .onConflictDoNothing({ target: idempotencyKeys.key })
          .returning(),
      );
      const stored = await this.get(row.key);
      if (!stored) throw new NotFoundError("idempotency_keys", row.key);
      return { inserted: returned.length > 0, row: stored };
    },
  };
}
