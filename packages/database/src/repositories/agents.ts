import { AgentRecordSchema, type AgentRecord } from "@overflow/schemas";
import { eq, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { withDbErrors } from "../errors";
import { agents } from "../schema";
import { iso, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

export type AgentInsert = WithOptional<AgentRecord, "id" | "createdAt">;

const toRecord = (r: typeof agents.$inferSelect): AgentRecord =>
  parseOne(AgentRecordSchema, {
    id: r.id,
    organizationId: r.organizationId,
    name: r.name,
    department: r.department,
    role: r.role,
    nodeId: opt(r.nodeId),
    key: r.key,
    parentAgentId: opt(r.parentAgentId),
    createdAt: iso(r.createdAt),
  });

const toRow = (row: AgentRecord): typeof agents.$inferInsert => ({
  id: row.id,
  organizationId: row.organizationId,
  name: row.name,
  department: row.department,
  role: row.role,
  nodeId: nul(row.nodeId),
  key: row.key,
  parentAgentId: nul(row.parentAgentId),
  createdAt: new Date(row.createdAt),
});

export function agentsRepository(db: Executor) {
  return {
    async insert(input: AgentInsert): Promise<AgentRecord> {
      const row = AgentRecordSchema.parse({
        ...input,
        id: input.id ?? newId(),
        createdAt: input.createdAt ?? nowIso(),
      });
      const [inserted] = await withDbErrors(() => db.insert(agents).values(toRow(row)).returning());
      return toRecord(inserted!);
    },

    async upsertById(input: AgentRecord): Promise<AgentRecord> {
      const row = AgentRecordSchema.parse(input);
      await withDbErrors(() =>
        db.insert(agents).values(toRow(row)).onConflictDoNothing({ target: agents.id }),
      );
      return (await this.getById(row.id))!;
    },

    async getById(id: string): Promise<AgentRecord | undefined> {
      const [r] = await db.select().from(agents).where(eq(agents.id, id));
      return r ? toRecord(r) : undefined;
    },

    /** Case-insensitive: chain logs return checksummed addresses, seeds may not. */
    async getByKey(key: string): Promise<AgentRecord | undefined> {
      const [r] = await db.select().from(agents).where(sql`lower(${agents.key}) = lower(${key})`);
      return r ? toRecord(r) : undefined;
    },

    /** Set once the treasury node exists onchain (NodeCreated event). */
    async setNodeId(id: string, nodeId: number): Promise<AgentRecord | undefined> {
      const [r] = await withDbErrors(() =>
        db.update(agents).set({ nodeId }).where(eq(agents.id, id)).returning(),
      );
      return r ? toRecord(r) : undefined;
    },

    async listByOrganization(organizationId: string): Promise<AgentRecord[]> {
      const rows = await db
        .select()
        .from(agents)
        .where(eq(agents.organizationId, organizationId))
        .orderBy(agents.createdAt);
      return rows.map(toRecord);
    },
  };
}
