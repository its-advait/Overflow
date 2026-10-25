import type { ActivityEvent, License } from "@overflow/schemas";
import { byNewest } from "@/lib/activity/filter";

// ---------------------------------------------------------------------------
// The Fusion check on /settings reads the service's own `fusion.decision` rows
// (written by POST /api/purchases/propose before any order is prepared) and
// shows what each one said. Parsing follows the exact reason strings Fusion
// writes (packages/fusion/src/rules.ts): nothing here re-judges a merge.
// ---------------------------------------------------------------------------

export type FusionVerdict = "merge" | "no-merge" | "none";

export interface ParsedFusionDecision {
  verdict: FusionVerdict;
  /** The listing the rules were judged on; null when no listing satisfied the requests. */
  listingId: string | null;
  /** Rule names in front of each "(evidence)" of a no-merge reason, in Fusion's rule order. */
  failingRules: string[];
  /** The reason sentence without the payer / "Requests stay separate" tail. */
  reason: string;
}

const MERGE = /^Merge: all \d+ rules pass for (?<ids>.+?) on (?<listing>\S+?)\.?(?:\s|$)/;
const NO_MERGE_ON = /^No merge of (?<ids>.+?) on (?<listing>\S+?): (?<rules>.+?)\. (?:Requests stay separate|Request)/s;
const NO_LISTING = /^No merge of (?<ids>.+?): no listing satisfies/;

export function parseFusionDecision(message: string): ParsedFusionDecision {
  const merge = MERGE.exec(message);
  if (merge?.groups) return { verdict: "merge", listingId: merge.groups["listing"]!, failingRules: [], reason: message.split(". ")[0]! };
  const noMerge = NO_MERGE_ON.exec(message);
  if (noMerge?.groups) {
    const rules = [...noMerge.groups["rules"]!.matchAll(/(?:^|; )([a-z]+) \(/g)].map((m) => m[1]!);
    return { verdict: "no-merge", listingId: noMerge.groups["listing"]!, failingRules: rules, reason: `${message.slice(0, message.indexOf(". Request") > 0 ? message.indexOf(". Request") : message.length)}` };
  }
  if (NO_LISTING.test(message)) return { verdict: "no-merge", listingId: null, failingRules: [], reason: message.split(". ")[0]! };
  return { verdict: "none", listingId: null, failingRules: [], reason: message };
}

/** The mission's Fusion decisions, newest first (the service lists a mission's activity oldest first). */
export function fusionDecisions(events: readonly ActivityEvent[], limit = 5): ActivityEvent[] {
  return events.filter((e) => e.kind === "fusion.decision").sort(byNewest).slice(0, limit);
}

/** What a license value means for Fusion (docs/SPEC.md "Fusion": shared internal use needs company-use; unclear means no merge). */
export const LICENSE_EFFECT: Record<License, string> = {
  "company-use": "Shared internal use: several agents' requests may merge into one purchase of this listing.",
  "single-user": "One seat: Fusion will not merge requests on this listing, and the Oracle skips it for company-use requests.",
  unclear: "Unclear license: no merge, and the Oracle rejects the listing for every request.",
};
