import { ResourceRequestSchema } from "@overflow/schemas";
import type { FusionRequest } from "./types";

export const NOW = new Date("2026-10-24T16:00:00Z");

/** Spec "Structured requests": Agent A (research) wants California, monthly, 2024-2026. */
export const AGENT_A: FusionRequest = {
  id: "req-a",
  agentId: "agent-research",
  ...ResourceRequestSchema.parse({
    topic: "EV registrations California",
    regions: ["US-CA"],
    dateRange: { start: "2024-01-01", end: "2026-09-30" },
    granularity: "monthly",
    requiredFields: ["brand", "units"],
    format: ["csv"],
    license: "company-use",
    freshness: { maxAgeDays: 90 },
    maxPriceAtomic: "7000000",
  }),
};

/** Agent B (finance) wants the United States, quarterly, 2025-2026. */
export const AGENT_B: FusionRequest = {
  id: "req-b",
  agentId: "agent-finance",
  ...ResourceRequestSchema.parse({
    topic: "EV registrations",
    regions: ["US"],
    dateRange: { start: "2025-01-01", end: "2026-09-30" },
    granularity: "quarterly",
    requiredFields: ["brand", "units"],
    format: ["csv"],
    license: "company-use",
    freshness: { maxAgeDays: 90 },
    maxPriceAtomic: "15000000",
  }),
};

export const NATIONAL = "listing-national-monthly-2024-2026";
export const CALIFORNIA = "listing-california-monthly-2024-2026";
export const ANNUAL = "listing-national-annual-2024-2026";
export const OLD = "listing-national-monthly-2021-2022";
export const SINGLE_USER = "listing-national-monthly-2024-2026-single-user";
