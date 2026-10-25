import { MissionRecordSchema, MissionStatusSchema, type MissionRecord } from "@overflow/schemas";
import { eq } from "drizzle-orm";
import type { Executor } from "../client";
import { withDbErrors } from "../errors";
import { missions } from "../schema";
import { iso, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

export type MissionInsert = WithOptional<MissionRecord, "id" | "createdAt" | "allowedFormats">;

const toRecord = (r: typeof missions.$inferSelect): MissionRecord =>
  parseOne(MissionRecordSchema, {
    id: r.id,
    organizationId: r.organizationId,
    goal: r.goal,
    budgetAtomic: r.budget,
    rootNodeId: r.rootNodeId,
    ownerAgentId: opt(r.ownerAgentId),
    horizon: r.horizon ?? undefined,
    allowedFormats: r.allowedFormats,
    status: r.status,
    createdAt: iso(r.createdAt),
  });

export function missionsRepository(db: Executor) {
  return {
    async insert(input: MissionInsert): Promise<MissionRecord> {
      const row = MissionRecordSchema.parse({
        ...input,
        id: input.id ?? newId(),
        createdAt: input.createdAt ?? nowIso(),
      });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(missions)
          .values({
            id: row.id,
            organizationId: row.organizationId,
            goal: row.goal,
            budget: row.budgetAtomic,
            rootNodeId: row.rootNodeId,
            ownerAgentId: nul(row.ownerAgentId),
            horizon: row.horizon ?? null,
            allowedFormats: row.allowedFormats,
            status: row.status,
            createdAt: new Date(row.createdAt),
          })
          .returning(),
      );
      return toRecord(inserted!);
    },

    async getById(id: string): Promise<MissionRecord | undefined> {
      const [r] = await db.select().from(missions).where(eq(missions.id, id));
      return r ? toRecord(r) : undefined;
    },

    async setStatus(id: string, status: MissionRecord["status"]): Promise<MissionRecord | undefined> {
      const next = MissionStatusSchema.parse(status);
      const [r] = await withDbErrors(() =>
        db.update(missions).set({ status: next }).where(eq(missions.id, id)).returning(),
      );
      return r ? toRecord(r) : undefined;
    },

    async listByOrganization(organizationId: string): Promise<MissionRecord[]> {
      const rows = await db
        .select()
        .from(missions)
        .where(eq(missions.organizationId, organizationId))
        .orderBy(missions.createdAt);
      return rows.map(toRecord);
    },
  };
}
