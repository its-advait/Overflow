import { atomicToBigInt } from "@overflow/schemas";
import { candidateGroups, type CandidateOptions } from "./candidates";
import { checkMerge } from "./rules";
import type { FusionListing, FusionRequest, MergeDecision } from "./types";

// ---------------------------------------------------------------------------
// The two-stage matcher end to end. Stage 1 (candidateGroups) proposes
// groups by topic keywords; stage 2 (checkMerge) decides against the
// listings every member could buy (Oracle's ranked survivors). Only stage 2
// can merge. Every iteration order is sorted, so the result is deterministic.
// ---------------------------------------------------------------------------

export interface FuseInput {
  requests: readonly FusionRequest[];
  /** Per request id: the listings Oracle accepted for it (rank order), i.e. what it could buy alone. */
  survivors: ReadonlyMap<string, readonly FusionListing[]>;
  /** Per request id: the listing it would buy alone (Oracle's top pick), if any. */
  standalone?: ReadonlyMap<string, FusionListing | undefined> | undefined;
  now: Date;
  candidates?: CandidateOptions | undefined;
}

export interface FuseResult {
  /** One decision per candidate group (or per merged pair when a group only partly merges). */
  merges: MergeDecision[];
  /** Request ids that belong to a merging decision. */
  mergedRequestIds: Set<string>;
}

const byPriceThenId = (a: FusionListing, b: FusionListing): number => {
  const pa = atomicToBigInt(a.priceAtomic);
  const pb = atomicToBigInt(b.priceAtomic);
  if (pa !== pb) return pa < pb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

function intersection(ids: readonly string[], survivors: FuseInput["survivors"]): FusionListing[] {
  const [first, ...rest] = ids;
  if (!first) return [];
  const others = rest.map((id) => new Set((survivors.get(id) ?? []).map((l) => l.id)));
  return [...(survivors.get(first) ?? [])].filter((l) => others.every((s) => s.has(l.id))).sort(byPriceThenId);
}

function union(ids: readonly string[], survivors: FuseInput["survivors"]): FusionListing[] {
  const seen = new Map<string, FusionListing>();
  for (const id of ids) for (const l of survivors.get(id) ?? []) seen.set(l.id, l);
  return [...seen.values()].sort(byPriceThenId);
}

/** Try to merge exactly these requests; returns the passing decision, else the cheapest candidate's failing decision (or null when nobody has a survivor). */
function tryGroup(ids: readonly string[], input: FuseInput, byId: ReadonlyMap<string, FusionRequest>): { decision: MergeDecision | null; merged: boolean } {
  const requests = ids.map((id) => byId.get(id)!);
  const common = intersection(ids, input.survivors);
  let best: MergeDecision | null = null;
  for (const listing of common) {
    const d = checkMerge({ listing, requests, standalone: input.standalone, now: input.now });
    if (d.merge) return { decision: d, merged: true };
    best ??= d;
  }
  if (!best) {
    // No listing is acceptable to everyone: explain with the cheapest listing anyone could buy.
    const cheapest = union(ids, input.survivors)[0];
    best = cheapest ? checkMerge({ listing: cheapest, requests, standalone: input.standalone, now: input.now }) : null;
  }
  return { decision: best, merged: false };
}

export function fuse(input: FuseInput): FuseResult {
  const byId = new Map(input.requests.map((r) => [r.id, r]));
  const merges: MergeDecision[] = [];
  const mergedRequestIds = new Set<string>();

  for (const group of candidateGroups(input.requests, input.candidates)) {
    const whole = tryGroup(group, input, byId);
    if (whole.merged && whole.decision) {
      merges.push(whole.decision);
      for (const id of group) mergedRequestIds.add(id);
      continue;
    }
    // Fall back to pairs in sorted order so two compatible requests still merge when a third does not fit.
    let anyPair = false;
    if (group.length > 2) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i]!;
          const b = group[j]!;
          if (mergedRequestIds.has(a) || mergedRequestIds.has(b)) continue;
          const pair = tryGroup([a, b], input, byId);
          if (pair.merged && pair.decision) {
            merges.push(pair.decision);
            mergedRequestIds.add(a);
            mergedRequestIds.add(b);
            anyPair = true;
          }
        }
      }
    }
    if (!anyPair) {
      merges.push(
        whole.decision ?? {
          listingId: null,
          requestIds: [...group],
          merge: false,
          checks: [],
          failingRules: [],
          reason: `No merge of ${group.join(", ")}: no listing satisfies any of these requests`,
          simulated: false,
        },
      );
    }
  }
  return { merges, mergedRequestIds };
}
