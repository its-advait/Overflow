import { z } from "zod";
import { AtomicAmountSchema, Bytes32Schema, IdSchema, IsoDateSchema } from "./primitives";

// Fusion "Structured requests": topic, regions, date range, granularity,
// required fields, format, license need, freshness, max price.

export const GranularitySchema = z.enum(["daily", "weekly", "monthly", "quarterly", "annual"]);
export type Granularity = z.infer<typeof GranularitySchema>;

/** Finer granularity can roll up to coarser, never the reverse. */
export const GRANULARITY_ORDER: Readonly<Record<Granularity, number>> = {
  daily: 0,
  weekly: 1,
  monthly: 2,
  quarterly: 3,
  annual: 4,
};

export const FormatSchema = z.enum(["csv", "json", "parquet"]);
export type Format = z.infer<typeof FormatSchema>;

/** "unclear" means no merge (SPEC: an unclear license means no merge). */
export const LicenseSchema = z.enum(["single-user", "company-use", "unclear"]);
export type License = z.infer<typeof LicenseSchema>;

export const FreshnessSchema = z.object({
  /** Data must be no older than this many days. */
  maxAgeDays: z.number().int().positive(),
});
export type Freshness = z.infer<typeof FreshnessSchema>;

export const DateRangeSchema = z
  .object({ start: IsoDateSchema, end: IsoDateSchema })
  .refine((r) => r.start <= r.end, { message: "dateRange.start must be <= dateRange.end", path: ["end"] });
export type DateRange = z.infer<typeof DateRangeSchema>;

export const ResourceRequestSchema = z.object({
  topic: z.string().min(1),
  regions: z.array(z.string().min(1)).min(1),
  dateRange: DateRangeSchema,
  granularity: GranularitySchema,
  requiredFields: z.array(z.string().min(1)),
  /** Formats the requesting agent can read. */
  format: z.array(FormatSchema).min(1),
  license: LicenseSchema,
  freshness: FreshnessSchema,
  maxPriceAtomic: AtomicAmountSchema,
});
export type ResourceRequest = z.infer<typeof ResourceRequestSchema>;

export const CoverageSchema = z.object({
  regions: z.array(z.string().min(1)).min(1),
  dateRange: DateRangeSchema,
  granularity: GranularitySchema,
  fields: z.array(z.string().min(1)),
  format: FormatSchema,
  /** When the listing was last refreshed. */
  asOf: IsoDateSchema.optional(),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const ResourceListingSchema = z.object({
  sellerId: IdSchema,
  productId: IdSchema,
  coverage: CoverageSchema,
  license: LicenseSchema,
  priceAtomic: AtomicAmountSchema,
  manifestHash: Bytes32Schema,
  /** Seats permitted by the license (1 for single-user). */
  seats: z.number().int().min(1),
  /** True for demo sellers and datasets; the UI must label them. */
  simulated: z.boolean().default(false),
});
export type ResourceListing = z.infer<typeof ResourceListingSchema>;
