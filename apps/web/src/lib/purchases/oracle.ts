import type { ResourceListing, ResourceRecord, ResourceRequest } from "@overflow/schemas";
import type { OracleDecision } from "../api/contracts";

// ---------------------------------------------------------------------------
// ResourceComparison view model. The Oracle's rank inputs are recomputed here
// with the two lines of packages/oracle/src/rank.ts (price per covered
// requirement, exact bigint); @overflow/oracle itself is not imported because
// its index pulls the Anthropic SDK into the browser bundle. OracleDecision
// carries only ids, so rows are joined with the catalog (GET /api/resources).
// ---------------------------------------------------------------------------

export interface ScoreInputs {
  /** regions + required fields + dates + granularity + format, as rank.ts counts them. */
  coveredRequirements: number;
  /** floor(priceAtomic / coveredRequirements), decimal string. */
  pricePerCoveredAtomic: string;
}

export function coveredRequirementCount(request: ResourceRequest): number {
  return request.regions.length + request.requiredFields.length + 3;
}

export function scoreInputs(request: ResourceRequest, listing: ResourceListing): ScoreInputs {
  const covered = coveredRequirementCount(request);
  return { coveredRequirements: covered, pricePerCoveredAtomic: (BigInt(listing.priceAtomic) / BigInt(covered)).toString(10) };
}

export type Verdict =
  | { kind: "chosen" }
  | { kind: "alternative" }
  | { kind: "rejected"; reasons: { reason: string; detail: string }[] };

export interface ComparisonRow {
  listingId: string;
  /** Missing when the catalog response did not include the listing. */
  listing?: ResourceRecord;
  /** 1 for the chosen listing, 2.. for alternatives in rank order; undefined for rejected ones. */
  rank?: number;
  verdict: Verdict;
  /** Only when the request record is known; otherwise the rank is the only score shown. */
  score?: ScoreInputs;
}

export function comparisonRows(
  decision: OracleDecision,
  resources: readonly ResourceRecord[],
  request?: ResourceRequest,
): ComparisonRow[] {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const row = (listingId: string, verdict: Verdict, rank?: number): ComparisonRow => {
    const listing = byId.get(listingId);
    return {
      listingId,
      ...(listing ? { listing } : {}),
      ...(rank !== undefined ? { rank } : {}),
      verdict,
      ...(request && listing && verdict.kind !== "rejected" ? { score: scoreInputs(request, listing) } : {}),
    };
  };
  const rows: ComparisonRow[] = [];
  if (decision.chosen) rows.push(row(decision.chosen, { kind: "chosen" }, 1));
  decision.alternatives.forEach((id, i) => rows.push(row(id, { kind: "alternative" }, (decision.chosen ? 2 : 1) + i)));
  for (const r of decision.rejected) rows.push(row(r.listingId, { kind: "rejected", reasons: r.reasons }));
  return rows;
}
