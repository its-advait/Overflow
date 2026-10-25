import { MERGE_RULES, type MergeRule } from "@overflow/fusion";
import type { ResourceRecord } from "@overflow/schemas";
import type { FusionOutcome, OracleDecision } from "../api/contracts";

// ---------------------------------------------------------------------------
// FusionProposal view model. "Avoided duplicate cost" is not a stored field;
// it is computed exactly as the price rule in packages/fusion/src/rules.ts:
// each request's standalone pick (Oracle's `chosen`), or the merged listing
// when it had none, summed and compared with the one merged price. bigint only.
// ---------------------------------------------------------------------------

/** The SPEC "Merge rules (all must pass)" table, exhaustive over MERGE_RULES. */
export const RULE_LABELS: Record<MergeRule, { title: string; rule: string }> = {
  identity: { title: "Resource identity", rule: "Same product, or an explicitly compatible substitute" },
  geography: { title: "Geography", rule: "Covers every requested region at usable detail" },
  dates: { title: "Dates", rule: "Covers both requested periods" },
  resolution: { title: "Resolution", rule: "Supports each agent's granularity (monthly can roll up to quarterly, not the reverse)" },
  fields: { title: "Fields", rule: "Every mandatory field for both agents is present" },
  format: { title: "Format", rule: "Both agents can read it, or a supported conversion exists" },
  license: { title: "License", rule: "Shared internal use and the seat count are permitted" },
  freshness: { title: "Freshness", rule: "Meets both agents' recency needs" },
  price: { title: "Price", rule: "One purchase actually costs less than two" },
};
export { MERGE_RULES };

export interface AvoidedCost {
  mergedAtomic: bigint;
  separateAtomic: bigint;
  /** separate - merged; the duplicate spend one purchase avoids. */
  savedAtomic: bigint;
  parts: { requestId: string; listingId: string; priceAtomic: bigint }[];
}

/** null when the outcome is not a merge or a listing is missing from the catalog response. */
export function avoidedDuplicateCost(
  outcome: FusionOutcome,
  decisions: readonly OracleDecision[],
  resources: readonly ResourceRecord[],
): AvoidedCost | null {
  if (!outcome.merge || !outcome.listingId) return null;
  const byId = new Map(resources.map((r) => [r.id, r]));
  const merged = byId.get(outcome.listingId);
  if (!merged) return null;
  const parts: AvoidedCost["parts"] = [];
  for (const requestId of outcome.requestIds) {
    const chosen = decisions.find((d) => d.requestId === requestId)?.chosen;
    const listing = chosen ? byId.get(chosen) : merged;
    if (!listing) return null;
    parts.push({ requestId, listingId: listing.id, priceAtomic: BigInt(listing.priceAtomic) });
  }
  const mergedAtomic = BigInt(merged.priceAtomic);
  const separateAtomic = parts.reduce((a, p) => a + p.priceAtomic, 0n);
  return { mergedAtomic, separateAtomic, savedAtomic: separateAtomic - mergedAtomic, parts };
}
