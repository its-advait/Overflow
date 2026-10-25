import type { FusionRequest } from "./types";

// ---------------------------------------------------------------------------
// Stage 1 of the two-stage matcher: keyword overlap between request topics
// proposes candidate pairs. It can never merge anything; only stage 2
// (rules.ts) decides. Embeddings are optional per the spec and not built.
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(["the", "of", "for", "and", "in", "on", "a", "an", "to", "data", "dataset", "datasets"]);

export function topicKeywords(topic: string): string[] {
  const seen = new Set<string>();
  for (const raw of topic.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP_WORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen].sort();
}

export interface CandidatePair {
  /** Request ids, `a < b`. */
  a: string;
  b: string;
  shared: string[];
}

export interface CandidateOptions {
  /** Minimum shared keywords for a pair (default 1). */
  minShared?: number | undefined;
}

const byId = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** Pairs of requests whose topics share at least `minShared` keywords, sorted by (a, b). */
export function candidatePairs(requests: readonly FusionRequest[], opts: CandidateOptions = {}): CandidatePair[] {
  const minShared = opts.minShared ?? 1;
  const sorted = [...requests].sort((x, y) => byId(x.id, y.id));
  const keywords = new Map(sorted.map((r) => [r.id, new Set(topicKeywords(r.topic))]));
  const out: CandidatePair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.id === b.id) continue;
      const shared = [...keywords.get(a.id)!].filter((k) => keywords.get(b.id)!.has(k)).sort();
      if (shared.length >= minShared) out.push({ a: a.id, b: b.id, shared });
    }
  }
  return out;
}

/** Connected components over candidate pairs; each group sorted, only groups of two or more. */
export function candidateGroups(requests: readonly FusionRequest[], opts: CandidateOptions = {}): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const r of requests) parent.set(r.id, r.id);
  for (const { a, b } of candidatePairs(requests, opts)) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map<string, string[]>();
  for (const r of requests) {
    const root = find(r.id);
    const list = groups.get(root) ?? [];
    list.push(r.id);
    groups.set(root, list);
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => [...new Set(g)].sort(byId))
    .sort((x, y) => byId(x[0]!, y[0]!));
}
