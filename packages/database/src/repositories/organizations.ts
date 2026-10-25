import { OrganizationSchema, type Organization } from "@overflow/schemas";
import { eq } from "drizzle-orm";
import type { Executor } from "../client";
import { withDbErrors } from "../errors";
import { organizations } from "../schema";
import { iso, newId, nowIso, nul, opt, parseOne, parseRows, type WithOptional } from "./base";

export type OrganizationInsert = WithOptional<Organization, "id" | "createdAt" | "simulated">;

const toRecord = (r: typeof organizations.$inferSelect): Organization =>
  parseOne(OrganizationSchema, {
    id: r.id,
    name: r.name,
    departments: r.departments,
    treasuryAddress: opt(r.treasuryAddress),
    simulated: r.simulated,
    createdAt: iso(r.createdAt),
  });

export function organizationsRepository(db: Executor) {
  return {
    async insert(input: OrganizationInsert): Promise<Organization> {
      const row = OrganizationSchema.parse({
        ...input,
        id: input.id ?? newId(),
        createdAt: input.createdAt ?? nowIso(),
      });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(organizations)
          .values({
            id: row.id,
            name: row.name,
            departments: row.departments,
            treasuryAddress: nul(row.treasuryAddress),
            simulated: row.simulated,
            createdAt: new Date(row.createdAt),
          })
          .returning(),
      );
      return toRecord(inserted!);
    },

    /** Insert unless the id exists; returns the stored row either way. */
    async upsertById(input: Organization): Promise<Organization> {
      const row = OrganizationSchema.parse(input);
      await withDbErrors(() =>
        db
          .insert(organizations)
          .values({
            id: row.id,
            name: row.name,
            departments: row.departments,
            treasuryAddress: nul(row.treasuryAddress),
            simulated: row.simulated,
            createdAt: new Date(row.createdAt),
          })
          .onConflictDoNothing({ target: organizations.id }),
      );
      const found = await this.getById(row.id);
      return found!;
    },

    async getById(id: string): Promise<Organization | undefined> {
      const [r] = await db.select().from(organizations).where(eq(organizations.id, id));
      return r ? toRecord(r) : undefined;
    },

    async list(): Promise<Organization[]> {
      const rows = await db.select().from(organizations).orderBy(organizations.createdAt);
      return parseRows(OrganizationSchema, rows.map(toRecord));
    },
  };
}
