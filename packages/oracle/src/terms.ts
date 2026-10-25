import { atomicToBigInt, formatUsdc, type ResourceRequest } from "@overflow/schemas";
import type { FilterResult, IdentifiedListing, Rejection } from "./types";

// ---------------------------------------------------------------------------
// Terms filter: price cap, freshness and license. Not coverage, but still
// decided by code. An unclear seller license is never bought here; asking
// the controller about it (SPEC "When it asks a human") is a later prompt.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** Whole days from `asOf` (calendar date) to `now`; negative when asOf is in the future. */
export function ageDays(asOf: string, now: Date): number {
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  return Math.floor((now.getTime() - asOfMs) / MS_PER_DAY);
}

export function termsRejections(request: ResourceRequest, listing: IdentifiedListing, now: Date): Rejection[] {
  const out: Rejection[] = [];

  if (atomicToBigInt(listing.priceAtomic) > atomicToBigInt(request.maxPriceAtomic)) {
    out.push({
      listingId: listing.id,
      reason: "price",
      detail: `price ${formatUsdc(listing.priceAtomic)} USDC exceeds max ${formatUsdc(request.maxPriceAtomic)} USDC`,
    });
  }

  const asOf = listing.coverage.asOf;
  if (asOf === undefined) {
    out.push({ listingId: listing.id, reason: "freshness", detail: "listing has no asOf date" });
  } else {
    const age = ageDays(asOf, now);
    if (age > request.freshness.maxAgeDays) {
      out.push({
        listingId: listing.id,
        reason: "freshness",
        detail: `asOf ${asOf} is ${age} days old, request allows ${request.freshness.maxAgeDays}`,
      });
    }
  }

  if (listing.license === "unclear") {
    out.push({ listingId: listing.id, reason: "license", detail: "seller license is unclear" });
  } else if (request.license !== "single-user" && listing.license !== "company-use") {
    // company-use (and an unclear request, conservatively) needs a company-use license.
    out.push({
      listingId: listing.id,
      reason: "license",
      detail: `request needs ${request.license}, listing is ${listing.license}`,
    });
  }

  return out;
}

export function filterByTerms<L extends IdentifiedListing>(
  request: ResourceRequest,
  listings: readonly L[],
  now: Date,
): FilterResult<L> {
  const accepted: L[] = [];
  const rejected: Rejection[] = [];
  for (const listing of listings) {
    const r = termsRejections(request, listing, now);
    if (r.length === 0) accepted.push(listing);
    else rejected.push(...r);
  }
  return { accepted, rejected };
}
