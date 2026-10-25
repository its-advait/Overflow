import { ExceptionRecordSchema, FinancialEntrySchema, LedgerAccountSchema, AtomicAmountSchema } from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { respond, type ApiEnv } from "../http.js";

const LedgerResponse = z.object({
  entries: z.array(FinancialEntrySchema),
  balances: z.array(
    z.object({ account: LedgerAccountSchema, debitsAtomic: AtomicAmountSchema, creditsAtomic: AtomicAmountSchema }),
  ),
});

const ReconciliationResponse = z.object({
  lastRun: z
    .object({
      ranAt: z.string(),
      treasuryBalanceAtomic: AtomicAmountSchema,
      ledgerTreasuryAtomic: AtomicAmountSchema,
      differenceAtomic: z.string().regex(/^-?(0|[1-9]\d*)$/),
      openEscrows: z.number().int().min(0),
      exceptions: z.array(ExceptionRecordSchema),
    })
    .nullable(),
  openExceptions: z.array(ExceptionRecordSchema),
  note: z.string().optional(),
});

export function ledgerRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();

  app.get("/ledger", async (c) => {
    const entries = await deps.repos.financialEntries.listAll();
    const balances = [];
    for (const account of LedgerAccountSchema.options) {
      const b = await deps.repos.financialEntries.balance(account);
      balances.push({ account, debitsAtomic: b.debitsAtomic.toString(), creditsAtomic: b.creditsAtomic.toString() });
    }
    return respond(c, LedgerResponse, { entries, balances });
  });

  /** Filled by the reconciliation job (P4.4). Until then lastRun is null and the note says so. */
  app.get("/reconciliation", async (c) => {
    const lastRun = await deps.ports.reconciliation.latest();
    const openExceptions = await deps.repos.exceptions.listOpen();
    return respond(c, ReconciliationResponse, {
      lastRun,
      openExceptions,
      ...(lastRun ? {} : { note: "reconciliation job not wired (P4.4); no run has been recorded" }),
    });
  });

  return app;
}
