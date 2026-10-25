import { ChainTransactionSchema, type ChainTransaction } from "@overflow/schemas";
import { and, eq } from "drizzle-orm";
import type { Executor } from "../client";
import { withDbErrors } from "../errors";
import { chainTransactions } from "../schema";
import { iso, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

export const TX_LOG_UNIQUE_CONSTRAINT = "chain_transactions_tx_hash_log_index_unique";

export type ChainTransactionInsert = WithOptional<ChainTransaction, "id" | "observedAt" | "confirmed">;

const toRecord = (r: typeof chainTransactions.$inferSelect): ChainTransaction =>
  parseOne(ChainTransactionSchema, {
    id: r.id,
    purchaseId: opt(r.purchaseId),
    txHash: r.txHash,
    logIndex: r.logIndex,
    blockNumber: r.blockNumber,
    contractAddress: r.contractAddress,
    eventName: r.eventName,
    args: r.args,
    observedAt: iso(r.observedAt),
    confirmed: r.confirmed,
  });

export function chainTransactionsRepository(db: Executor) {
  return {
    /**
     * Idempotent on (txHash, logIndex): the indexer can replay a block range
     * safely. `inserted` is false when the log was already recorded.
     */
    async record(input: ChainTransactionInsert): Promise<{ inserted: boolean; row: ChainTransaction }> {
      const row = ChainTransactionSchema.parse({
        confirmed: true,
        ...input,
        id: input.id ?? newId(),
        observedAt: input.observedAt ?? nowIso(),
      });
      const returned = await withDbErrors(() =>
        db
          .insert(chainTransactions)
          .values({
            id: row.id,
            purchaseId: nul(row.purchaseId),
            txHash: row.txHash,
            logIndex: row.logIndex,
            blockNumber: row.blockNumber,
            contractAddress: row.contractAddress,
            eventName: row.eventName,
            args: row.args,
            observedAt: new Date(row.observedAt),
            confirmed: row.confirmed,
          })
          .onConflictDoNothing({ target: [chainTransactions.txHash, chainTransactions.logIndex] })
          .returning(),
      );
      if (returned[0]) return { inserted: true, row: toRecord(returned[0]) };
      const existing = await this.getByLog(row.txHash, row.logIndex);
      return { inserted: false, row: existing! };
    },

    async getById(id: string): Promise<ChainTransaction | undefined> {
      const [r] = await db.select().from(chainTransactions).where(eq(chainTransactions.id, id));
      return r ? toRecord(r) : undefined;
    },

    async getByLog(txHash: string, logIndex: number): Promise<ChainTransaction | undefined> {
      const [r] = await db
        .select()
        .from(chainTransactions)
        .where(and(eq(chainTransactions.txHash, txHash), eq(chainTransactions.logIndex, logIndex)));
      return r ? toRecord(r) : undefined;
    },

    async listByPurchase(purchaseId: string): Promise<ChainTransaction[]> {
      const rows = await db
        .select()
        .from(chainTransactions)
        .where(eq(chainTransactions.purchaseId, purchaseId))
        .orderBy(chainTransactions.observedAt);
      return rows.map(toRecord);
    },

    async listByTxHash(txHash: string): Promise<ChainTransaction[]> {
      const rows = await db
        .select()
        .from(chainTransactions)
        .where(eq(chainTransactions.txHash, txHash))
        .orderBy(chainTransactions.logIndex);
      return rows.map(toRecord);
    },
  };
}
