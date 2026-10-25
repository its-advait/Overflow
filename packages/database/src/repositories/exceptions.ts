import { ExceptionRecordSchema, type ExceptionRecord } from "@overflow/schemas";
import { eq } from "drizzle-orm";
import type { Executor } from "../client";
import { NotFoundError, withDbErrors } from "../errors";
import { exceptions } from "../schema";
import { iso, isoOpt, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

export type ExceptionInsert = WithOptional<ExceptionRecord, "id" | "openedAt" | "status">;

const toRecord = (r: typeof exceptions.$inferSelect): ExceptionRecord =>
  parseOne(ExceptionRecordSchema, {
    id: r.id,
    type: r.type,
    reason: r.reason,
    amountAtomic: opt(r.amount),
    status: r.status,
    openedAt: iso(r.openedAt),
    purchaseId: opt(r.purchaseId),
    resolvedBy: opt(r.resolvedBy),
    resolvedAt: isoOpt(r.resolvedAt),
  });

export function exceptionsRepository(db: Executor) {
  return {
    async open(input: ExceptionInsert): Promise<ExceptionRecord> {
      const row = ExceptionRecordSchema.parse({
        status: "open",
        ...input,
        id: input.id ?? newId(),
        openedAt: input.openedAt ?? nowIso(),
      });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(exceptions)
          .values({
            id: row.id,
            type: row.type,
            reason: row.reason,
            amount: nul(row.amountAtomic),
            status: row.status,
            purchaseId: nul(row.purchaseId),
            resolvedBy: nul(row.resolvedBy),
            openedAt: new Date(row.openedAt),
            resolvedAt: row.resolvedAt ? new Date(row.resolvedAt) : null,
          })
          .returning(),
      );
      return toRecord(inserted!);
    },

    async getById(id: string): Promise<ExceptionRecord | undefined> {
      const [r] = await db.select().from(exceptions).where(eq(exceptions.id, id));
      return r ? toRecord(r) : undefined;
    },

    /** A human (the controller) resolves or dismisses; the row records who. */
    async resolve(id: string, resolvedBy: string, outcome: "resolved" | "dismissed" = "resolved"): Promise<ExceptionRecord> {
      const [r] = await withDbErrors(() =>
        db
          .update(exceptions)
          .set({ status: outcome, resolvedBy, resolvedAt: new Date() })
          .where(eq(exceptions.id, id))
          .returning(),
      );
      if (!r) throw new NotFoundError("exceptions", id);
      return toRecord(r);
    },

    async listOpen(): Promise<ExceptionRecord[]> {
      const rows = await db.select().from(exceptions).where(eq(exceptions.status, "open")).orderBy(exceptions.openedAt);
      return rows.map(toRecord);
    },
  };
}
