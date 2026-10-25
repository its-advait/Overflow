import type { ResourceListing } from "@overflow/schemas";

// ---------------------------------------------------------------------------
// Shared Oracle types. A listing is a ResourceListing plus the id the UI and
// purchases refer to; CatalogEntry (datasets) and ResourceRecord (database)
// both satisfy it.
// ---------------------------------------------------------------------------

export type IdentifiedListing = ResourceListing & { id: string; title?: string };

/** Which deterministic check a listing failed. The model never produces these. */
export type RejectionReason =
  | "region"
  | "dateRange"
  | "granularity"
  | "field"
  | "format"
  | "price"
  | "freshness"
  | "license"
  | "owned";

export interface Rejection {
  listingId: string;
  reason: RejectionReason;
  /** Human-readable detail with the compared values, e.g. "covers 2021-01-01..2022-12-31, request needs 2024-01-01..2026-09-30". */
  detail: string;
}

export interface FilterResult<L extends IdentifiedListing> {
  accepted: L[];
  rejected: Rejection[];
}
