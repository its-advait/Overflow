import {
  FinancialEntrySchema,
  LedgerAccountSchema,
  atomicToBigInt,
  type FinancialEntry,
  type LedgerAccount,
} from "@overflow/schemas";
import { eq, or } from "drizzle-orm";
import type { Executor } from "../client";
import { withDbErrors } from "../errors";
import { financialEntries } from "../schema";
import { iso, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

export const SOURCE_EVENT_UNIQUE_CONSTRAINT = "financial_entries_source_event_id_unique";

export type FinancialEntryInsert = WithOptional<FinancialEntry, "id" | "postedAt">;

const toRecord = (r: typeof financialEntries.$inferSelect): FinancialEntry =>
  parseOne(FinancialEntrySchema, {
    id: r.id,
    purchaseId: opt(r.purchaseId),
    debitAccount: r.debitAccount,
    creditAccount: r.creditAccount,
    amountAtomic: r.amount,
    memo: r.memo,
    sourceEventId: r.sourceEventId,
    department: opt(r.department),
    txHash: opt(r.txHash),
    correctsEntryId: opt(r.correctsEntryId),
    postedAt: iso(r.postedAt),
  });

export function financialEntriesRepository(db: Executor) {
  return {
    /**
     * Posts one double-entry row. A second row for the same sourceEventId
     * throws UniqueViolationError (every chain event books exactly once).
     * Rows are never updated or deleted; corrections are new rows.
     */
    async post(input: FinancialEntryInsert): Promise<FinancialEntry> {
      const row = FinancialEntrySchema.parse({
        ...input,
        id: input.id ?? newId(),
        postedAt: input.postedAt ?? nowIso(),
      });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(financialEntries)
          .values({
            id: row.id,
            purchaseId: nul(row.purchaseId),
            debitAccount: row.debitAccount,
            creditAccount: row.creditAccount,
            amount: row.amountAtomic,
            memo: row.memo,
            sourceEventId: row.sourceEventId,
            department: nul(row.department),
            txHash: nul(row.txHash),
            correctsEntryId: nul(row.correctsEntryId),
            postedAt: new Date(row.postedAt),
          })
          .returning(),
      );
      return toRecord(inserted!);
    },

    async getById(id: string): Promise<FinancialEntry | undefined> {
      const [r] = await db.select().from(financialEntries).where(eq(financialEntries.id, id));
      return r ? toRecord(r) : undefined;
    },

    async getBySourceEvent(sourceEventId: string): Promise<FinancialEntry | undefined> {
      const [r] = await db
        .select()
        .from(financialEntries)
        .where(eq(financialEntries.sourceEventId, sourceEventId));
      return r ? toRecord(r) : undefined;
    },

    async listForPurchase(purchaseId: string): Promise<FinancialEntry[]> {
      const rows = await db
        .select()
        .from(financialEntries)
        .where(eq(financialEntries.purchaseId, purchaseId))
        .orderBy(financialEntries.postedAt);
      return rows.map(toRecord);
    },

    async listAll(): Promise<FinancialEntry[]> {
      const rows = await db.select().from(financialEntries).orderBy(financialEntries.postedAt);
      return rows.map(toRecord);
    },

    /**
     * Account totals summed in TypeScript with bigint (never SQL float).
     * The caller decides the normal balance (asset accounts: debits - credits).
     */
    async balance(account: LedgerAccount): Promise<{ debitsAtomic: bigint; creditsAtomic: bigint }> {
      const acct = LedgerAccountSchema.parse(account);
      const rows = await db
        .select()
        .from(financialEntries)
        .where(or(eq(financialEntries.debitAccount, acct), eq(financialEntries.creditAccount, acct)));
      let debitsAtomic = 0n;
      let creditsAtomic = 0n;
      for (const r of rows) {
        const amount = atomicToBigInt(r.amount);
        if (r.debitAccount === acct) debitsAtomic += amount;
        if (r.creditAccount === acct) creditsAtomic += amount;
      }
      return { debitsAtomic, creditsAtomic };
    },
  };
}
