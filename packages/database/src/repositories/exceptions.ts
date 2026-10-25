import {
  ExceptionRecordSchema,
  type ExceptionDecision,
  type ExceptionRecord,
  type ExceptionStatus,
} from "@overflow/schemas";
import { and, eq } from "drizzle-orm";
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
    subject: opt(r.subject),
    requestedBy: opt(r.requestedBy),
    details: opt(r.details),
    resolvedBy: opt(r.resolvedBy),
    resolvedAt: isoOpt(r.resolvedAt),
    decision: opt(r.decision),
    decisionReason: opt(r.decisionReason),
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
            subject: nul(row.subject),
            requestedBy: nul(row.requestedBy),
            details: nul(row.details),
            resolvedBy: nul(row.resolvedBy),
            decision: nul(row.decision),
            decisionReason: nul(row.decisionReason),
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

    /**
     * Closes the exception and records who did it and why. `resolvedBy` is a
     * human principal, or "chain" when the indexer saw the confirming event.
     */
    async resolve(
      id: string,
      resolvedBy: string,
      outcome: "resolved" | "dismissed" = "resolved",
      extra: { decision?: ExceptionDecision; decisionReason?: string } = {},
    ): Promise<ExceptionRecord> {
      const [r] = await withDbErrors(() =>
        db
          .update(exceptions)
          .set({
            status: outcome,
            resolvedBy,
            resolvedAt: new Date(),
            ...(extra.decision ? { decision: extra.decision } : {}),
            ...(extra.decisionReason ? { decisionReason: extra.decisionReason } : {}),
          })
          .where(eq(exceptions.id, id))
          .returning(),
      );
      if (!r) throw new NotFoundError("exceptions", id);
      return toRecord(r);
    },

    /** The open exception about `subject` of this type, if any (a known case is not raised twice). */
    async findOpenBySubject(type: ExceptionRecord["type"], subject: string): Promise<ExceptionRecord | undefined> {
      const [r] = await db
        .select()
        .from(exceptions)
        .where(and(eq(exceptions.type, type), eq(exceptions.subject, subject), eq(exceptions.status, "open")));
      return r ? toRecord(r) : undefined;
    },

    async listOpen(): Promise<ExceptionRecord[]> {
      return this.list("open");
    },

    /** Oldest first. */
    async list(status: ExceptionStatus | "all" = "all"): Promise<ExceptionRecord[]> {
      const q = db.select().from(exceptions);
      const rows = await (status === "all" ? q : q.where(eq(exceptions.status, status))).orderBy(exceptions.openedAt);
      return rows.map(toRecord);
    },
  };
}
