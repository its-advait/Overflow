import {
  AtomicAmountSchema,
  atomicToBigInt,
  ExceptionRecordSchema,
  FinancialEntrySchema,
  IdSchema,
  LedgerAccountSchema,
  ReconciliationRunSchema,
  SignedAtomicSchema,
} from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { parseQuery, respond, type ApiEnv } from "../http.js";

const LedgerQuery = z.object({
  purchaseId: IdSchema.optional(),
  /** Rows that debit or credit this account. */
  account: LedgerAccountSchema.optional(),
  /** Split lines booked to this department. */
  department: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const BalanceSchema = z.object({
  account: LedgerAccountSchema,
  debitsAtomic: AtomicAmountSchema,
  creditsAtomic: AtomicAmountSchema,
  /** debits - credits (asset/expense accounts read positive, liability/equity/income read negative). */
  netAtomic: SignedAtomicSchema,
});

/**
 * The Fusion allocation breakdown: for every purchase the books touched, each
 * department's planned share (the purchase's allocations) beside what the
 * ledger booked to data-expense for it. They differ legitimately while an order
 * is still in escrow (booked 0) and when posting integer-scaled a chain amount.
 */
const AllocationBreakdownSchema = z.object({
  purchaseId: IdSchema,
  purchaseGroupId: IdSchema.nullable(),
  department: z.string().min(1),
  /** Planned share from the purchase's Fusion allocations; null when the purchase has no allocation for this department. */
  allocatedAtomic: AtomicAmountSchema.nullable(),
  /** Net data-expense the ledger booked to this purchase and department. */
  bookedAtomic: SignedAtomicSchema,
});

const LedgerResponse = z.object({
  /** Filtered by the query; newest first when `limit` is given. */
  entries: z.array(FinancialEntrySchema),
  /** Whole-book totals regardless of the entry filters. */
  balances: z.array(BalanceSchema),
  /** Per-department totals of the rows carrying a department (the data-expense split); whole book. */
  departments: z.array(BalanceSchema.extend({ department: z.string().min(1) })),
  allocations: z.array(AllocationBreakdownSchema),
});

const ReconciliationResponse = z.object({
  lastRun: ReconciliationRunSchema.nullable(),
  openExceptions: z.array(ExceptionRecordSchema),
  note: z.string().optional(),
});

const RunResponse = z.object({ run: ReconciliationRunSchema });

/** Booked data-expense per (purchase, department) joined with the purchase's planned allocations. bigint only. */
async function allocationBreakdown(deps: ApiDeps): Promise<z.infer<typeof AllocationBreakdownSchema>[]> {
  const booked = await deps.repos.financialEntries.expenseByPurchaseAndDepartment();
  const purchaseIds = [...new Set(booked.map((b) => b.purchaseId))];
  const purchases = new Map((await deps.repos.purchases.listByIds(purchaseIds)).map((p) => [p.id, p]));
  const rows = new Map<string, z.infer<typeof AllocationBreakdownSchema>>();
  const keyOf = (purchaseId: string, department: string) => `${purchaseId}\u0000${department}`;
  for (const b of booked) {
    const purchase = purchases.get(b.purchaseId);
    const planned = purchase?.allocations.filter((a) => a.department === b.department) ?? [];
    rows.set(keyOf(b.purchaseId, b.department), {
      purchaseId: b.purchaseId,
      purchaseGroupId: purchase?.purchaseGroupId ?? null,
      department: b.department,
      allocatedAtomic: planned.length > 0 ? planned.reduce((sum, a) => sum + atomicToBigInt(a.amountAtomic), 0n).toString() : null,
      bookedAtomic: b.netAtomic.toString(),
    });
  }
  // Planned departments of those same purchases that the books have not (yet) expensed: shown with booked 0.
  for (const purchase of purchases.values()) {
    for (const a of purchase.allocations) {
      const k = keyOf(purchase.id, a.department);
      if (rows.has(k)) continue;
      const planned = purchase.allocations.filter((x) => x.department === a.department);
      rows.set(k, {
        purchaseId: purchase.id,
        purchaseGroupId: purchase.purchaseGroupId ?? null,
        department: a.department,
        allocatedAtomic: planned.reduce((sum, x) => sum + atomicToBigInt(x.amountAtomic), 0n).toString(),
        bookedAtomic: "0",
      });
    }
  }
  return [...rows.values()].sort((x, y) => x.purchaseId.localeCompare(y.purchaseId) || x.department.localeCompare(y.department));
}

export function ledgerRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();

  app.get("/ledger", async (c) => {
    const q = parseQuery(c, LedgerQuery);
    const entries = await deps.repos.financialEntries.listAll({
      purchaseId: q.purchaseId,
      account: q.account,
      department: q.department,
      limit: q.limit,
    });
    const balances = (await deps.repos.financialEntries.balances()).map((b) => ({
      account: b.account,
      debitsAtomic: b.debitsAtomic.toString(),
      creditsAtomic: b.creditsAtomic.toString(),
      netAtomic: (b.debitsAtomic - b.creditsAtomic).toString(),
    }));
    const departments = (await deps.repos.financialEntries.departmentBalances()).map((b) => ({
      department: b.department,
      account: b.account,
      debitsAtomic: b.debitsAtomic.toString(),
      creditsAtomic: b.creditsAtomic.toString(),
      netAtomic: (b.debitsAtomic - b.creditsAtomic).toString(),
    }));
    const allocations = await allocationBreakdown(deps);
    return respond(c, LedgerResponse, { entries, balances, departments, allocations });
  });

  /** The last recorded run (a table, so it survives restarts) and every exception still waiting on the controller. */
  app.get("/reconciliation", async (c) => {
    const lastRun = (await deps.repos.reconciliationRuns.latest()) ?? null;
    const openExceptions = await deps.repos.exceptions.listOpen();
    return respond(c, ReconciliationResponse, {
      lastRun,
      openExceptions,
      ...(lastRun ? {} : { note: "no reconciliation run has been recorded yet" }),
    });
  });

  /** On-demand run. 501 when no chain reader is wired (no RPC / deployments). */
  app.post("/reconciliation/run", async (c) => {
    const run = await deps.ports.reconciliation.run("api");
    return respond(c, RunResponse, { run });
  });

  return app;
}
