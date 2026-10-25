import type { ResourceRequest } from "@overflow/schemas";
import { filterByCoverage } from "./coverage";
import { explain, type Explanation } from "./explain";
import { skipOwned, type OwnedResource } from "./owned";
import { rank, type RankedListing } from "./rank";
import { filterByTerms } from "./terms";
import type { IdentifiedListing, Rejection } from "./types";

// ---------------------------------------------------------------------------
// The deterministic pipeline: skipOwned -> filterByCoverage -> filterByTerms
// -> rank -> explain. No model output enters it; the request is whatever the
// user approved after editing the extracted requirements.
// ---------------------------------------------------------------------------

export interface RecommendInput<L extends IdentifiedListing> {
  request: ResourceRequest;
  listings: readonly L[];
  owned?: readonly OwnedResource[];
  /** Clock for freshness; defaults to now. */
  now?: Date;
  /** Carried into the explanation (e.g. from extraction). */
  assumptions?: readonly string[];
}

export interface Recommendation<L extends IdentifiedListing> {
  ranked: RankedListing<L>[];
  rejected: Rejection[];
  explanation: Explanation;
}

export function recommend<L extends IdentifiedListing>(input: RecommendInput<L>): Recommendation<L> {
  const now = input.now ?? new Date();
  const owned = skipOwned(input.listings, input.owned ?? []);
  const coverage = filterByCoverage(input.request, owned.kept);
  const terms = filterByTerms(input.request, coverage.accepted, now);
  const ranked = rank(terms.accepted, input.request);
  const rejected = [...owned.skipped, ...coverage.rejected, ...terms.rejected];
  const explanation = explain({
    ranked,
    rejected,
    assumptions: input.assumptions ?? [],
    considered: input.listings,
  });
  return { ranked, rejected, explanation };
}
