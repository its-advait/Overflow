import {
  FinancialEntrySchema,
  LedgerAccountSchema,
  atomicToBigInt,
  type FinancialEntry,
  type LedgerAccount,
} from "@overflow/schemas";
import { desc, eq, or } from "drizzle-orm";
import type { Executor } from "../client";
import { withDbErrors } from "../errors";
import { financialEntries } from "../schema";
import { iso, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

export const SOURCE_EVENT_UNIQUE_CONSTRAINT = "financial_entries_source_event_id_unique";

/** `eventKey` defaults to `sourceEventId` (a single-line entry). */
export type FinancialEntryInsert = WithOptional<FinancialEntry, "id" | "postedAt" | "eventKey">;

export interface AccountBalance {
  account: LedgerAccount;
  debitsAtomic: bigint;
  creditsAtomic: bigint;
}

export interface DepartmentBalance {
  department: string;
  account: LedgerAccount;
  debitsAtomic: bigint;
  creditsAtomic: bigint;
}

const toRecord = (r: typeof financialEntries.$inferSelect): FinancialEntry =>
  parseOne(FinancialEntrySchema, {
    id: r.id,
    purchaseId: opt(r.purchaseId),
    debitAccount: r.debitAccount,
    creditAccount: r.creditAccount,
    amountAtomic: r.amount,
    memo: r.memo,
    eventKey: r.eventKey,
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
        eventKey: input.eventKey ?? input.sourceEventId,
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
            eventKey: row.eventKey,
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

    /** Every line booked for one chain event (one row, or one per department). */
    async listByEventKey(eventKey: string): Promise<FinancialEntry[]> {
      const rows = await db
        .select()
        .from(financialEntries)
        .where(eq(financialEntries.eventKey, eventKey))
        .orderBy(financialEntries.postedAt, financialEntries.sourceEventId);
      return rows.map(toRecord);
    },

    /** Every line booked from any log of one transaction. */
    async listByTxHash(txHash: string): Promise<FinancialEntry[]> {
      const rows = await db
        .select()
        .from(financialEntries)
        .where(eq(financialEntries.txHash, txHash))
        .orderBy(financialEntries.postedAt, financialEntries.sourceEventId);
      return rows.map(toRecord);
    },

    async listForPurchase(purchaseId: string): Promise<FinancialEntry[]> {
      const rows = await db
        .select()
        .from(financialEntries)
        .where(eq(financialEntries.purchaseId, purchaseId))
        .orderBy(financialEntries.postedAt, financialEntries.sourceEventId);
      return rows.map(toRecord);
    },

    /** Newest first when a limit is given (the API view); chronological otherwise. */
    async listAll(opts: { purchaseId?: string | undefined; limit?: number | undefined } = {}): Promise<FinancialEntry[]> {
      const base = db.select().from(financialEntries);
      const filtered = opts.purchaseId ? base.where(eq(financialEntries.purchaseId, opts.purchaseId)) : base;
      const rows =
        opts.limit !== undefined
          ? await filtered.orderBy(desc(financialEntries.postedAt), desc(financialEntries.sourceEventId)).limit(opts.limit)
          : await filtered.orderBy(financialEntries.postedAt, financialEntries.sourceEventId);
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

    /** Debits and credits of every account in one pass (bigint). Accounts with no rows are present with zeros. */
    async balances(): Promise<AccountBalance[]> {
      const totals = new Map<LedgerAccount, AccountBalance>();
      for (const account of LedgerAccountSchema.options) totals.set(account, { account, debitsAtomic: 0n, creditsAtomic: 0n });
      for (const r of await db.select().from(financialEntries)) {
        const amount = atomicToBigInt(r.amount);
        totals.get(LedgerAccountSchema.parse(r.debitAccount))!.debitsAtomic += amount;
        totals.get(LedgerAccountSchema.parse(r.creditAccount))!.creditsAtomic += amount;
      }
      return [...totals.values()];
    },

    /** Per-department data-expense totals (the Fusion split). Only the expense account is departmental. */
    async departmentBalances(): Promise<DepartmentBalance[]> {
      const totals = new Map<string, DepartmentBalance>();
      const bump = (department: string, side: "debitsAtomic" | "creditsAtomic", amount: bigint): void => {
        const t = totals.get(department) ?? { department, account: "data-expense", debitsAtomic: 0n, creditsAtomic: 0n };
        t[side] += amount;
        totals.set(department, t);
      };
      for (const r of await db.select().from(financialEntries)) {
        if (!r.department) continue;
        const amount = atomicToBigInt(r.amount);
        if (r.debitAccount === "data-expense") bump(r.department, "debitsAtomic", amount);
        if (r.creditAccount === "data-expense") bump(r.department, "creditsAtomic", amount);
      }
      return [...totals.values()].sort((a, b) => a.department.localeCompare(b.department));
    },

    /** Net escrow-deposit line for one order (debits - credits); what the books say the escrow holds for the treasury. */
    async depositLineForPurchase(purchaseId: string): Promise<bigint> {
      let net = 0n;
      for (const r of await db.select().from(financialEntries).where(eq(financialEntries.purchaseId, purchaseId))) {
        const amount = atomicToBigInt(r.amount);
        if (r.debitAccount === "escrow-deposit") net += amount;
        if (r.creditAccount === "escrow-deposit") net -= amount;
      }
      return net;
    },
  };
}
