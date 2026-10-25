import { SampleRecordSchema, type SampleRecord } from "@overflow/schemas";
import { eq } from "drizzle-orm";
import type { Executor } from "../client";
import { withDbErrors } from "../errors";
import { samples } from "../schema";
import { iso, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

export type SampleInsert = WithOptional<SampleRecord, "id" | "createdAt" | "judge" | "rows" | "simulated">;

const toRecord = (r: typeof samples.$inferSelect): SampleRecord =>
  parseOne(SampleRecordSchema, {
    id: r.id,
    purchaseId: r.purchaseId,
    indices: r.indices,
    randomness: opt(r.randomness),
    verdict: r.verdict,
    reason: r.reason,
    judge: r.judge,
    rows: r.rows,
    confidence: r.confidence == null ? undefined : Number(r.confidence),
    promptHash: opt(r.promptHash),
    outputHash: opt(r.outputHash),
    simulated: r.simulated,
    createdAt: iso(r.createdAt),
  });

export function samplesRepository(db: Executor) {
  return {
    async insert(input: SampleInsert): Promise<SampleRecord> {
      const row = SampleRecordSchema.parse({
        ...input,
        id: input.id ?? newId(),
        createdAt: input.createdAt ?? nowIso(),
      });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(samples)
          .values({
            id: row.id,
            purchaseId: row.purchaseId,
            indices: row.indices,
            randomness: nul(row.randomness),
            verdict: row.verdict,
            reason: row.reason,
            judge: row.judge,
            rows: row.rows,
            confidence: row.confidence === undefined ? null : String(row.confidence),
            promptHash: nul(row.promptHash),
            outputHash: nul(row.outputHash),
            simulated: row.simulated,
            createdAt: new Date(row.createdAt),
          })
          .returning(),
      );
      return toRecord(inserted!);
    },

    async getById(id: string): Promise<SampleRecord | undefined> {
      const [r] = await db.select().from(samples).where(eq(samples.id, id));
      return r ? toRecord(r) : undefined;
    },

    async listByPurchase(purchaseId: string): Promise<SampleRecord[]> {
      const rows = await db.select().from(samples).where(eq(samples.purchaseId, purchaseId)).orderBy(samples.createdAt);
      return rows.map(toRecord);
    },
  };
}
