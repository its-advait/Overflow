import { ResourceRequestSchema, type ResourceRequest } from "@overflow/schemas";

/** Test fixture: the national, monthly, 2024-01..2026-09 request (Fusion agent A with US geography). */
export const NATIONAL_MONTHLY: ResourceRequest = ResourceRequestSchema.parse({
  topic: "EV registrations",
  regions: ["US"],
  dateRange: { start: "2024-01-01", end: "2026-09-30" },
  granularity: "monthly",
  requiredFields: ["brand", "units", "state"],
  format: ["csv"],
  license: "company-use",
  freshness: { maxAgeDays: 90 },
  maxPriceAtomic: "15000000",
});

export const NATIONAL_MONTHLY_COVERAGE = {
  regions: ["US"],
  dateRange: { start: "2024-01-01", end: "2026-09-30" },
  granularity: "monthly" as const,
  fields: ["month", "state", "brand", "units"],
  format: "csv" as const,
  asOf: "2026-10-15",
};
