import { IdSchema, type ResourceListing, type ResourceRequest } from "@overflow/schemas";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Fusion types (docs/SPEC.md "Fusion: one purchase for many agents").
// A request is a ResourceRequest plus its id and the agent that filed it
// (a ResourceRequestRecord satisfies it). A listing is a ResourceListing plus
// its id (a ResourceRecord or CatalogEntry satisfies it).
// ---------------------------------------------------------------------------

export type FusionRequest = ResourceRequest & { id: string; agentId: string };
export type FusionListing = ResourceListing & { id: string; title?: string | undefined };

/** The spec's merge-rule table, in table order. All must pass. */
export const MERGE_RULES = [
  "identity",
  "geography",
  "dates",
  "resolution",
  "fields",
  "format",
  "license",
  "freshness",
  "price",
] as const;
export const MergeRuleSchema = z.enum(MERGE_RULES);
export type MergeRule = z.infer<typeof MergeRuleSchema>;

/** One rule's verdict with the compared values, for the FusionProposal UI. */
export const RuleCheckSchema = z.object({
  rule: MergeRuleSchema,
  passed: z.boolean(),
  evidence: z.string().min(1),
});
export type RuleCheck = z.infer<typeof RuleCheckSchema>;

export const MergeDecisionSchema = z.object({
  /** Listing judged; null only when no request had any surviving listing. */
  listingId: IdSchema.nullable(),
  /** Sorted ids of the requests judged together. */
  requestIds: z.array(IdSchema).min(1),
  merge: z.boolean(),
  checks: z.array(RuleCheckSchema),
  failingRules: z.array(MergeRuleSchema),
  /** "Merge: ..." or "No merge: <rule> (<evidence>); ..." so the failing rule is always named. */
  reason: z.string().min(1),
  /** True when the listing is a simulated demo seller; the UI must label it. */
  simulated: z.boolean(),
});
export type MergeDecision = z.infer<typeof MergeDecisionSchema>;
