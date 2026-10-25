import { PurchaseGroupSchema, type PurchaseGroup } from "@overflow/schemas";
import { eq } from "drizzle-orm";
import type { Executor } from "../client";
import { withDbErrors } from "../errors";
import { purchaseGroups } from "../schema";
import { iso, newId, nowIso, parseOne, type WithOptional } from "./base";

export type PurchaseGroupInsert = WithOptional<PurchaseGroup, "id" | "createdAt">;

const toRecord = (r: typeof purchaseGroups.$inferSelect): PurchaseGroup =>
  parseOne(PurchaseGroupSchema, {
    id: r.id,
    missionId: r.missionId,
    resourceId: r.resourceId,
    payingNodeId: r.payingNodeId,
    requestIds: r.requestIds,
    mergeReason: r.mergeReason,
    createdAt: iso(r.createdAt),
  });

export function purchaseGroupsRepository(db: Executor) {
  return {
    async insert(input: PurchaseGroupInsert): Promise<PurchaseGroup> {
      const row = PurchaseGroupSchema.parse({
        ...input,
        id: input.id ?? newId(),
        createdAt: input.createdAt ?? nowIso(),
      });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(purchaseGroups)
          .values({ ...row, createdAt: new Date(row.createdAt) })
          .returning(),
      );
      return toRecord(inserted!);
    },

    async getById(id: string): Promise<PurchaseGroup | undefined> {
      const [r] = await db.select().from(purchaseGroups).where(eq(purchaseGroups.id, id));
      return r ? toRecord(r) : undefined;
    },

    async listByMission(missionId: string): Promise<PurchaseGroup[]> {
      const rows = await db
        .select()
        .from(purchaseGroups)
        .where(eq(purchaseGroups.missionId, missionId))
        .orderBy(purchaseGroups.createdAt);
      return rows.map(toRecord);
    },
  };
}
