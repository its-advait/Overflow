import {
  ResourceRecordSchema,
  ResourceRequestRecordSchema,
  type ResourceRecord,
  type ResourceRequest,
  type ResourceRequestRecord,
} from "@overflow/schemas";
import { eq } from "drizzle-orm";
import type { Executor } from "../client";
import { withDbErrors } from "../errors";
import { resourceRequests, resources } from "../schema";
import { iso, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

export type ResourceInsert = WithOptional<ResourceRecord, "id" | "createdAt" | "simulated">;
export type ResourceRequestInsert = WithOptional<ResourceRequestRecord, "id" | "createdAt" | "status">;

const toResource = (r: typeof resources.$inferSelect): ResourceRecord =>
  parseOne(ResourceRecordSchema, {
    id: r.id,
    title: r.title,
    url: opt(r.url),
    sellerId: r.sellerId,
    productId: r.productId,
    coverage: r.coverage,
    license: r.license,
    priceAtomic: r.price,
    manifestHash: r.manifestHash,
    seats: r.seats,
    simulated: r.simulated,
    createdAt: iso(r.createdAt),
  });

const toRequest = (r: typeof resourceRequests.$inferSelect): ResourceRequestRecord =>
  parseOne(ResourceRequestRecordSchema, {
    id: r.id,
    missionId: r.missionId,
    agentId: r.agentId,
    status: r.status,
    topic: r.topic,
    regions: r.regions,
    dateRange: r.dateRange,
    granularity: r.granularity,
    requiredFields: r.requiredFields,
    format: r.format,
    license: r.license,
    freshness: r.freshness,
    maxPriceAtomic: r.maxPrice,
    createdAt: iso(r.createdAt),
  });

export function resourcesRepository(db: Executor) {
  return {
    async insert(input: ResourceInsert): Promise<ResourceRecord> {
      const row = ResourceRecordSchema.parse({
        ...input,
        id: input.id ?? newId(),
        createdAt: input.createdAt ?? nowIso(),
      });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(resources)
          .values({
            id: row.id,
            title: row.title,
            url: nul(row.url),
            sellerId: row.sellerId,
            productId: row.productId,
            coverage: row.coverage,
            license: row.license,
            price: row.priceAtomic,
            manifestHash: row.manifestHash,
            seats: row.seats,
            simulated: row.simulated,
            createdAt: new Date(row.createdAt),
          })
          .returning(),
      );
      return toResource(inserted!);
    },

    /** Insert unless the id exists; returns the stored row either way (catalog seeding is idempotent). */
    async upsertById(input: ResourceRecord): Promise<ResourceRecord> {
      const row = ResourceRecordSchema.parse(input);
      await withDbErrors(() =>
        db
          .insert(resources)
          .values({
            id: row.id,
            title: row.title,
            url: nul(row.url),
            sellerId: row.sellerId,
            productId: row.productId,
            coverage: row.coverage,
            license: row.license,
            price: row.priceAtomic,
            manifestHash: row.manifestHash,
            seats: row.seats,
            simulated: row.simulated,
            createdAt: new Date(row.createdAt),
          })
          .onConflictDoNothing({ target: resources.id }),
      );
      const found = await this.getById(row.id);
      return found!;
    },

    /** A judge's edit (price, license, seats) of one listing; undefined when the id is unknown. */
    async update(id: string, fields: { priceAtomic?: string | undefined; license?: ResourceRecord["license"] | undefined; seats?: number | undefined }): Promise<ResourceRecord | undefined> {
      const set = {
        ...(fields.priceAtomic !== undefined ? { price: fields.priceAtomic } : {}),
        ...(fields.license !== undefined ? { license: fields.license } : {}),
        ...(fields.seats !== undefined ? { seats: fields.seats } : {}),
      };
      if (Object.keys(set).length === 0) return this.getById(id);
      await withDbErrors(() => db.update(resources).set(set).where(eq(resources.id, id)));
      return this.getById(id);
    },

    async getById(id: string): Promise<ResourceRecord | undefined> {
      const [r] = await db.select().from(resources).where(eq(resources.id, id));
      return r ? toResource(r) : undefined;
    },

    async list(): Promise<ResourceRecord[]> {
      const rows = await db.select().from(resources).orderBy(resources.createdAt);
      return rows.map(toResource);
    },
  };
}

export function resourceRequestsRepository(db: Executor) {
  return {
    async insert(input: ResourceRequestInsert): Promise<ResourceRequestRecord> {
      const row = ResourceRequestRecordSchema.parse({
        status: "open",
        ...input,
        id: input.id ?? newId(),
        createdAt: input.createdAt ?? nowIso(),
      });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(resourceRequests)
          .values({
            id: row.id,
            missionId: row.missionId,
            agentId: row.agentId,
            status: row.status,
            topic: row.topic,
            regions: row.regions,
            dateRange: row.dateRange,
            granularity: row.granularity,
            requiredFields: row.requiredFields,
            format: row.format,
            license: row.license,
            freshness: row.freshness,
            maxPrice: row.maxPriceAtomic,
            createdAt: new Date(row.createdAt),
          })
          .returning(),
      );
      return toRequest(inserted!);
    },

    async getById(id: string): Promise<ResourceRequestRecord | undefined> {
      const [r] = await db.select().from(resourceRequests).where(eq(resourceRequests.id, id));
      return r ? toRequest(r) : undefined;
    },

    async setStatus(
      id: string,
      status: ResourceRequestRecord["status"],
    ): Promise<ResourceRequestRecord | undefined> {
      const [r] = await withDbErrors(() =>
        db
          .update(resourceRequests)
          .set({ status })
          .where(eq(resourceRequests.id, id))
          .returning(),
      );
      return r ? toRequest(r) : undefined;
    },

    /** The owner's edit of an extracted request: every requirement field, never status, agent or mission. */
    async update(id: string, fields: ResourceRequest): Promise<ResourceRequestRecord | undefined> {
      const [r] = await withDbErrors(() =>
        db
          .update(resourceRequests)
          .set({
            topic: fields.topic,
            regions: fields.regions,
            dateRange: fields.dateRange,
            granularity: fields.granularity,
            requiredFields: fields.requiredFields,
            format: fields.format,
            license: fields.license,
            freshness: fields.freshness,
            maxPrice: fields.maxPriceAtomic,
          })
          .where(eq(resourceRequests.id, id))
          .returning(),
      );
      return r ? toRequest(r) : undefined;
    },

    async listByMission(missionId: string): Promise<ResourceRequestRecord[]> {
      const rows = await db
        .select()
        .from(resourceRequests)
        .where(eq(resourceRequests.missionId, missionId))
        .orderBy(resourceRequests.createdAt);
      return rows.map(toRequest);
    },
  };
}
