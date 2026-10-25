import { formatUsdc } from "@overflow/schemas";
import type { RankedListing, RankInputs } from "./rank";
import type { IdentifiedListing, Rejection } from "./types";

// ---------------------------------------------------------------------------
// Explanation (SPEC "Oracle" > Explanation): what was chosen, what was
// rejected and why, and the assumptions. Built from the deterministic
// results only; shown in ResourceComparison. It authorizes nothing.
// ---------------------------------------------------------------------------

export interface ChosenListing {
  listingId: string;
  title: string | undefined;
  sellerId: string;
  priceAtomic: string;
  inputs: RankInputs;
  simulated: boolean;
}

export interface RejectedListing {
  listingId: string;
  reasons: Rejection[];
}

export interface Explanation {
  chosen: ChosenListing | null;
  /** Ranked survivors other than the chosen one, in rank order. */
  alternatives: RankedListing[];
  rejected: RejectedListing[];
  assumptions: string[];
  summary: string;
  /** True when any considered listing is simulated; the UI must label it. */
  simulated: boolean;
}

export interface ChoiceInput<L extends IdentifiedListing> {
  ranked: readonly RankedListing<L>[];
  rejected: readonly Rejection[];
  assumptions: readonly string[];
  considered: readonly L[];
}

export function groupRejections(rejected: readonly Rejection[]): RejectedListing[] {
  const map = new Map<string, Rejection[]>();
  for (const r of rejected) {
    const list = map.get(r.listingId) ?? [];
    list.push(r);
    map.set(r.listingId, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([listingId, reasons]) => ({ listingId, reasons }));
}

export function explain<L extends IdentifiedListing>(choice: ChoiceInput<L>): Explanation {
  const [top, ...rest] = choice.ranked;
  const chosen: ChosenListing | null = top
    ? {
        listingId: top.listing.id,
        title: top.listing.title,
        sellerId: top.listing.sellerId,
        priceAtomic: top.listing.priceAtomic,
        inputs: top.inputs,
        simulated: top.listing.simulated,
      }
    : null;
  const rejected = groupRejections(choice.rejected);
  const simulated = choice.considered.some((l) => l.simulated);

  const lines: string[] = [];
  if (chosen) {
    lines.push(
      `Chose ${chosen.listingId} from ${chosen.sellerId} at ${formatUsdc(chosen.priceAtomic)} USDC ` +
        `(${formatUsdc(chosen.inputs.pricePerCoveredAtomic)} USDC per covered requirement, ${chosen.inputs.coveredRequirements} requirements` +
        `${chosen.inputs.asOf ? `, as of ${chosen.inputs.asOf}` : ""}).`,
    );
  } else {
    lines.push("No listing satisfies the request.");
  }
  for (const alt of rest) {
    lines.push(`Alternative #${alt.rank}: ${alt.listing.id} at ${formatUsdc(alt.listing.priceAtomic)} USDC.`);
  }
  for (const r of rejected) {
    lines.push(`Rejected ${r.listingId}: ${r.reasons.map((x) => `${x.reason} (${x.detail})`).join("; ")}.`);
  }
  for (const a of choice.assumptions) lines.push(`Assumption: ${a}`);
  if (simulated) lines.push("All considered listings are SIMULATED demo sellers.");
  lines.push("This is a recommendation; it authorizes no payment.");

  return {
    chosen,
    alternatives: rest,
    rejected,
    assumptions: [...choice.assumptions],
    summary: lines.join("\n"),
    simulated,
  };
}
