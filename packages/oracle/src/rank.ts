import { atomicToBigInt, type ResourceRequest } from "@overflow/schemas";
import type { IdentifiedListing } from "./types";

// ---------------------------------------------------------------------------
// Ranking (SPEC "Oracle" > Ranking): price per covered requirement, freshness
// as the tie-breaker, listing id as the final tie-breaker so the order never
// depends on input order. Exact bigint arithmetic; no floats.
// ---------------------------------------------------------------------------

export interface RankInputs {
  priceAtomic: string;
  /** Requirement units the request carries: regions + required fields + dates + granularity + format. */
  coveredRequirements: number;
  /** floor(priceAtomic / coveredRequirements), decimal string. */
  pricePerCoveredAtomic: string;
  asOf: string | undefined;
}

export interface RankedListing<L extends IdentifiedListing = IdentifiedListing> {
  rank: number;
  listing: L;
  inputs: RankInputs;
}

/** Every listing passed to rank() has passed the filters, so it covers all of these. */
export function coveredRequirementCount(request: ResourceRequest): number {
  return request.regions.length + request.requiredFields.length + 3;
}

export function rank<L extends IdentifiedListing>(listings: readonly L[], request: ResourceRequest): RankedListing<L>[] {
  const covered = coveredRequirementCount(request);
  const coveredBig = BigInt(covered);
  const scored = listings.map((listing) => {
    const price = atomicToBigInt(listing.priceAtomic);
    return {
      listing,
      price,
      inputs: {
        priceAtomic: listing.priceAtomic,
        coveredRequirements: covered,
        pricePerCoveredAtomic: (price / coveredBig).toString(10),
        asOf: listing.coverage.asOf,
      } satisfies RankInputs,
    };
  });
  // Same divisor for every entry, so price per covered requirement orders like price; the
  // cross-multiplication keeps the comparison exact if the divisor ever differs.
  scored.sort((a, b) => {
    const lhs = a.price * coveredBig;
    const rhs = b.price * coveredBig;
    if (lhs !== rhs) return lhs < rhs ? -1 : 1;
    const aFresh = a.inputs.asOf ?? "";
    const bFresh = b.inputs.asOf ?? "";
    if (aFresh !== bFresh) return aFresh > bFresh ? -1 : 1; // newer first, missing last
    return a.listing.id < b.listing.id ? -1 : a.listing.id > b.listing.id ? 1 : 0;
  });
  return scored.map((s, i) => ({ rank: i + 1, listing: s.listing, inputs: s.inputs }));
}
