import { GRANULARITY_ORDER, type ResourceRequest } from "@overflow/schemas";
import type { FilterResult, IdentifiedListing, Rejection } from "./types";

// ---------------------------------------------------------------------------
// Coverage filter (docs/SPEC.md "Oracle" > Coverage filter): deterministic
// code, not the model. A listing is rejected when it misses any requested
// region, the date range, the granularity, a required field or the format.
// Every failing check is reported so the UI can show all of them.
// ---------------------------------------------------------------------------

const norm = (s: string): string => s.trim().toLowerCase();

export function coverageRejections(request: ResourceRequest, listing: IdentifiedListing): Rejection[] {
  const out: Rejection[] = [];
  const c = listing.coverage;

  const regions = new Set(c.regions);
  const missingRegions = request.regions.filter((r) => !regions.has(r));
  if (missingRegions.length > 0) {
    out.push({
      listingId: listing.id,
      reason: "region",
      detail: `missing region(s) ${missingRegions.join(", ")}; listing covers ${c.regions.join(", ")}`,
    });
  }

  if (c.dateRange.start > request.dateRange.start || c.dateRange.end < request.dateRange.end) {
    out.push({
      listingId: listing.id,
      reason: "dateRange",
      detail: `covers ${c.dateRange.start}..${c.dateRange.end}, request needs ${request.dateRange.start}..${request.dateRange.end}`,
    });
  }

  // Finer granularity rolls up to coarser, never the reverse.
  if (GRANULARITY_ORDER[c.granularity] > GRANULARITY_ORDER[request.granularity]) {
    out.push({
      listingId: listing.id,
      reason: "granularity",
      detail: `${c.granularity} cannot roll down to ${request.granularity}`,
    });
  }

  const fields = new Set(c.fields.map(norm));
  const missingFields = request.requiredFields.filter((f) => !fields.has(norm(f)));
  if (missingFields.length > 0) {
    out.push({
      listingId: listing.id,
      reason: "field",
      detail: `missing field(s) ${missingFields.join(", ")}; listing has ${c.fields.join(", ")}`,
    });
  }

  if (!request.format.includes(c.format)) {
    out.push({
      listingId: listing.id,
      reason: "format",
      detail: `listing is ${c.format}, request reads ${request.format.join(", ")}`,
    });
  }

  return out;
}

export function filterByCoverage<L extends IdentifiedListing>(
  request: ResourceRequest,
  listings: readonly L[],
): FilterResult<L> {
  const accepted: L[] = [];
  const rejected: Rejection[] = [];
  for (const listing of listings) {
    const r = coverageRejections(request, listing);
    if (r.length === 0) accepted.push(listing);
    else rejected.push(...r);
  }
  return { accepted, rejected };
}
