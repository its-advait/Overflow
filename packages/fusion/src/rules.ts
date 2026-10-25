import { atomicToBigInt, formatUsdc, GRANULARITY_ORDER, type Coverage } from "@overflow/schemas";
import { MERGE_RULES, type FusionListing, type FusionRequest, type MergeDecision, type MergeRule, type RuleCheck } from "./types";

// ---------------------------------------------------------------------------
// Stage 2 of the matcher: deterministic checks of every merge rule in the
// spec table against the listing's structured metadata. Every rule is
// evaluated (no short circuit) and reports pass/fail with the compared values
// so the UI can show all of them. Only this file can say "merge".
// ---------------------------------------------------------------------------

export interface CheckMergeInput {
  listing: FusionListing;
  /** Two or more requests judged together (one request is allowed; it then trivially "merges" with itself). */
  requests: readonly FusionRequest[];
  /** Per request: the listing it would buy alone (Oracle's standalone pick), if any. */
  standalone?: ReadonlyMap<string, FusionListing | undefined> | undefined;
  /** Clock for freshness. */
  now: Date;
}

const MS_PER_DAY = 86_400_000;
const norm = (s: string): string => s.trim().toLowerCase();
const byId = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** Whole days from `asOf` (calendar date, UTC) to `now`; negative when asOf is in the future. */
export function ageDays(asOf: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(`${asOf}T00:00:00Z`)) / MS_PER_DAY);
}

/** Does `outer` cover everything `inner` covers? Used for "explicitly compatible substitute". */
function coverageContains(outer: Coverage, inner: Coverage): boolean {
  const regions = new Set(outer.regions);
  return (
    inner.regions.every((r) => regions.has(r)) &&
    outer.dateRange.start <= inner.dateRange.start &&
    outer.dateRange.end >= inner.dateRange.end &&
    GRANULARITY_ORDER[outer.granularity] <= GRANULARITY_ORDER[inner.granularity] &&
    inner.fields.every((f) => outer.fields.map(norm).includes(norm(f))) &&
    outer.format === inner.format
  );
}

function check(rule: MergeRule, failures: string[], pass: string): RuleCheck {
  return failures.length === 0 ? { rule, passed: true, evidence: pass } : { rule, passed: false, evidence: failures.join("; ") };
}

export function checkMerge(input: CheckMergeInput): MergeDecision {
  const { listing, now } = input;
  const requests = [...input.requests].sort((x, y) => byId(x.id, y.id));
  const standalone = input.standalone ?? new Map<string, FusionListing | undefined>();
  const c = listing.coverage;
  const checks: RuleCheck[] = [];

  // Resource identity: same product, or an explicitly compatible substitute.
  {
    const failures: string[] = [];
    const notes: string[] = [];
    for (const r of requests) {
      const own = standalone.get(r.id);
      if (!own) {
        notes.push(`${r.id}: no standalone listing, judged on coverage`);
      } else if (own.manifestHash === listing.manifestHash) {
        notes.push(`${r.id}: same product as ${own.id} (manifestHash ${listing.manifestHash.slice(0, 10)}…)`);
      } else if (own.sellerId === listing.sellerId && own.productId === listing.productId) {
        notes.push(`${r.id}: same product as ${own.id} (${listing.sellerId}/${listing.productId})`);
      } else if (coverageContains(c, own.coverage)) {
        notes.push(`${r.id}: compatible substitute for ${own.id} (coverage contained)`);
      } else {
        failures.push(`${r.id}: ${listing.id} is neither ${own.id} nor a superset of its coverage`);
      }
    }
    checks.push(check("identity", failures, notes.join("; ")));
  }

  // Geography: covers every requested region at usable detail (region codes, set containment).
  {
    const regions = new Set(c.regions);
    const wanted = [...new Set(requests.flatMap((r) => r.regions))].sort();
    const missing = wanted.filter((r) => !regions.has(r));
    checks.push(
      check(
        "geography",
        missing.length ? [`missing region(s) ${missing.join(", ")}; listing covers ${c.regions.join(", ")}`] : [],
        `covers ${wanted.join(", ")} (listing: ${c.regions.join(", ")})`,
      ),
    );
  }

  // Dates: covers both requested periods.
  {
    const failures = requests
      .filter((r) => c.dateRange.start > r.dateRange.start || c.dateRange.end < r.dateRange.end)
      .map((r) => `${r.id} needs ${r.dateRange.start}..${r.dateRange.end}, listing covers ${c.dateRange.start}..${c.dateRange.end}`);
    checks.push(check("dates", failures, `listing ${c.dateRange.start}..${c.dateRange.end} covers ${requests.map((r) => `${r.dateRange.start}..${r.dateRange.end}`).join(" and ")}`));
  }

  // Resolution: finer rolls up to coarser, never the reverse.
  {
    const failures = requests
      .filter((r) => GRANULARITY_ORDER[c.granularity] > GRANULARITY_ORDER[r.granularity])
      .map((r) => `${c.granularity} cannot roll down to ${r.granularity} (${r.id})`);
    checks.push(check("resolution", failures, `${c.granularity} serves ${[...new Set(requests.map((r) => r.granularity))].join(" and ")}`));
  }

  // Fields: every mandatory field for both agents is present.
  {
    const fields = new Set(c.fields.map(norm));
    const failures: string[] = [];
    for (const r of requests) {
      const missing = r.requiredFields.filter((f) => !fields.has(norm(f)));
      if (missing.length) failures.push(`${r.id} missing field(s) ${missing.join(", ")}`);
    }
    checks.push(check("fields", failures, `listing has ${c.fields.join(", ")}`));
  }

  // Format: both agents can read it.
  {
    const failures = requests.filter((r) => !r.format.includes(c.format)).map((r) => `${r.id} reads ${r.format.join(", ")}, listing is ${c.format}`);
    checks.push(check("format", failures, `${c.format} readable by every request`));
  }

  // License: shared internal use and the seat count are permitted. Unclear means no merge.
  {
    const agents = [...new Set(requests.map((r) => r.agentId))];
    const failures: string[] = [];
    if (listing.license === "unclear") failures.push("unclear license: no merge");
    else if (listing.license !== "company-use") failures.push(`license is ${listing.license}, shared internal use needs company-use`);
    for (const r of requests) if (r.license === "unclear") failures.push(`${r.id} has an unclear license need`);
    if (listing.seats < agents.length) failures.push(`${listing.seats} seat(s) for ${agents.length} agents`);
    checks.push(check("license", failures, `${listing.license}, ${listing.seats} seats for ${agents.length} agents`));
  }

  // Freshness: meets both agents' recency needs.
  {
    const failures: string[] = [];
    let pass = "";
    if (c.asOf === undefined) failures.push("listing has no asOf date");
    else {
      const age = ageDays(c.asOf, now);
      for (const r of requests) if (age > r.freshness.maxAgeDays) failures.push(`asOf ${c.asOf} is ${age} days old, ${r.id} allows ${r.freshness.maxAgeDays}`);
      pass = `asOf ${c.asOf} is ${age} days old, within ${requests.map((r) => r.freshness.maxAgeDays).join(" and ")}`;
    }
    checks.push(check("freshness", failures, pass));
  }

  // Price: fits the agents' combined caps (each share, weighted by cap, then fits its own cap),
  // and one purchase actually costs less than separate ones.
  {
    const price = atomicToBigInt(listing.priceAtomic);
    const failures: string[] = [];
    const caps = requests.reduce((a, r) => a + atomicToBigInt(r.maxPriceAtomic), 0n);
    if (price > caps) failures.push(`${formatUsdc(price)} USDC exceeds the combined caps ${formatUsdc(caps)} USDC (${requests.map((r) => formatUsdc(r.maxPriceAtomic)).join(" + ")})`);
    const separate = requests.map((r) => atomicToBigInt((standalone.get(r.id) ?? listing).priceAtomic));
    const total = separate.reduce((a, b) => a + b, 0n);
    const text = `one purchase ${formatUsdc(price)} USDC vs ${formatUsdc(total)} USDC separately (${separate.map((s) => formatUsdc(s)).join(" + ")}), caps ${formatUsdc(caps)} USDC`;
    if (requests.length > 1 && price >= total) failures.push(`no saving: ${text}`);
    checks.push(check("price", failures, text));
  }

  const ordered = MERGE_RULES.map((rule) => checks.find((k) => k.rule === rule)!);
  const failing = ordered.filter((k) => !k.passed);
  const requestIds = requests.map((r) => r.id);
  const reason = failing.length
    ? `No merge of ${requestIds.join(", ")} on ${listing.id}: ${failing.map((k) => `${k.rule} (${k.evidence})`).join("; ")}`
    : `Merge: all ${MERGE_RULES.length} rules pass for ${requestIds.join(", ")} on ${listing.id}`;
  return {
    listingId: listing.id,
    requestIds,
    merge: failing.length === 0,
    checks: ordered,
    failingRules: failing.map((k) => k.rule),
    reason,
    simulated: listing.simulated,
  };
}
