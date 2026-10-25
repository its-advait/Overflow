import {
  AtomicAmountSchema,
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
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const BalanceSchema = z.object({
  account: LedgerAccountSchema,
  debitsAtomic: AtomicAmountSchema,
  creditsAtomic: AtomicAmountSchema,
  /** debits - credits (asset/expense accounts read positive, liability/equity/income read negative). */
  netAtomic: SignedAtomicSchema,
});

const LedgerResponse = z.object({
  entries: z.array(FinancialEntrySchema),
  balances: z.array(BalanceSchema),
  /** Per-department totals of the rows carrying a department (the data-expense split). */
  departments: z.array(BalanceSchema.extend({ department: z.string().min(1) })),
});

const ReconciliationResponse = z.object({
  lastRun: ReconciliationRunSchema.nullable(),
  openExceptions: z.array(ExceptionRecordSchema),
  note: z.string().optional(),
});

const RunResponse = z.object({ run: ReconciliationRunSchema });

export function ledgerRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();

  app.get("/ledger", async (c) => {
    const q = parseQuery(c, LedgerQuery);
    const entries = await deps.repos.financialEntries.listAll({ purchaseId: q.purchaseId, limit: q.limit });
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
    return respond(c, LedgerResponse, { entries, balances, departments });
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
