import { IndexerCursorSchema, type IndexerCursor } from "@overflow/schemas";
import { eq } from "drizzle-orm";
import type { Executor } from "../client";
import { withDbErrors } from "../errors";
import { indexerCursors } from "../schema";
import { iso, parseOne } from "./base";

const toRecord = (r: typeof indexerCursors.$inferSelect): IndexerCursor =>
  parseOne(IndexerCursorSchema, { name: r.name, lastBlock: r.lastBlock, updatedAt: iso(r.updatedAt) });

/** Indexer checkpoints: the highest block fully scanned per log stream. */
export function indexerCursorsRepository(db: Executor) {
  return {
    async get(name: string): Promise<IndexerCursor | undefined> {
      const [r] = await db.select().from(indexerCursors).where(eq(indexerCursors.name, name));
      return r ? toRecord(r) : undefined;
    },

    /** Upsert. `lastBlock` is a decimal string or bigint; never a float. */
    async set(name: string, lastBlock: string | bigint): Promise<IndexerCursor> {
      const value = IndexerCursorSchema.shape.lastBlock.parse(String(lastBlock));
      const [r] = await withDbErrors(() =>
        db
          .insert(indexerCursors)
          .values({ name, lastBlock: value, updatedAt: new Date() })
          .onConflictDoUpdate({ target: indexerCursors.name, set: { lastBlock: value, updatedAt: new Date() } })
          .returning(),
      );
      return toRecord(r!);
    },
  };
}
