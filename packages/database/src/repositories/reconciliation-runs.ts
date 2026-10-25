import { ReconciliationRunSchema, type ReconciliationRun } from "@overflow/schemas";
import { desc } from "drizzle-orm";
import type { Executor } from "../client";
import { withDbErrors } from "../errors";
import { reconciliationRuns } from "../schema";
import { iso, newId, nowIso, parseOne, type WithOptional } from "./base";

export type ReconciliationRunInsert = WithOptional<ReconciliationRun, "id" | "ranAt">;

const toRecord = (r: typeof reconciliationRuns.$inferSelect): ReconciliationRun =>
  parseOne(ReconciliationRunSchema, {
    id: r.id,
    ranAt: iso(r.ranAt),
    trigger: r.trigger,
    blockNumber: r.blockNumber,
    treasuryChainAtomic: r.treasuryChain,
    treasuryLedgerAtomic: r.treasuryLedger,
    treasuryDifferenceAtomic: r.treasuryDifference,
    escrowsChecked: r.escrowsChecked,
    eventsChecked: r.eventsChecked,
    differences: r.differences,
    exceptionIds: r.exceptionIds,
    status: r.status,
  });

export function reconciliationRunsRepository(db: Executor) {
  return {
    async insert(input: ReconciliationRunInsert): Promise<ReconciliationRun> {
      const row = ReconciliationRunSchema.parse({ ...input, id: input.id ?? newId(), ranAt: input.ranAt ?? nowIso() });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(reconciliationRuns)
          .values({
            id: row.id,
            ranAt: new Date(row.ranAt),
            trigger: row.trigger,
            blockNumber: row.blockNumber,
            treasuryChain: row.treasuryChainAtomic,
            treasuryLedger: row.treasuryLedgerAtomic,
            treasuryDifference: row.treasuryDifferenceAtomic,
            escrowsChecked: row.escrowsChecked,
            eventsChecked: row.eventsChecked,
            differences: row.differences,
            exceptionIds: row.exceptionIds,
            status: row.status,
          })
          .returning(),
      );
      return toRecord(inserted!);
    },

    async latest(): Promise<ReconciliationRun | undefined> {
      const [r] = await db.select().from(reconciliationRuns).orderBy(desc(reconciliationRuns.ranAt)).limit(1);
      return r ? toRecord(r) : undefined;
    },

    async listRecent(limit = 20): Promise<ReconciliationRun[]> {
      const rows = await db.select().from(reconciliationRuns).orderBy(desc(reconciliationRuns.ranAt)).limit(limit);
      return rows.map(toRecord);
    },
  };
}
