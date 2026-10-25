import { loadCatalog } from "@overflow/datasets";
import { describe, expect, it } from "vitest";
import { AGENT_A, AGENT_B, ANNUAL, CALIFORNIA, NATIONAL, NOW, OLD, SINGLE_USER } from "./fixtures.test-helper";
import { checkMerge } from "./rules";
import { MERGE_RULES, type FusionListing } from "./types";

const catalogPromise = loadCatalog();
const listing = async (id: string): Promise<FusionListing> => {
  const { listings } = await catalogPromise;
  return listings.find((l) => l.id === id)!;
};

describe("stage 2: merge rules against the SIMULATED P5.1 catalog", () => {
  it("the national monthly company-use set passes all nine rules for A (California monthly) and B (US quarterly)", async () => {
    const standalone = new Map([
      ["req-a", await listing(CALIFORNIA)],
      ["req-b", await listing(NATIONAL)],
    ]);
    const d = checkMerge({ listing: await listing(NATIONAL), requests: [AGENT_B, AGENT_A], standalone, now: NOW });
    expect(d.merge).toBe(true);
    expect(d.failingRules).toEqual([]);
    expect(d.checks.map((c) => c.rule)).toEqual([...MERGE_RULES]);
    expect(d.checks.every((c) => c.passed)).toBe(true);
    expect(d.requestIds).toEqual(["req-a", "req-b"]);
    expect(d.checks.find((c) => c.rule === "identity")!.evidence).toContain("compatible substitute for listing-california-monthly-2024-2026");
    expect(d.checks.find((c) => c.rule === "price")!.evidence).toBe("one purchase 12.00 USDC vs 17.00 USDC separately (5.00 + 12.00), caps 22.00 USDC");
    expect(d.reason).toMatch(/^Merge: all 9 rules pass/);
    expect(d.simulated).toBe(true);
  });

  it("California-only fails geography for B; the evidence names the missing region", async () => {
    const d = checkMerge({ listing: await listing(CALIFORNIA), requests: [AGENT_A, AGENT_B], now: NOW });
    expect(d.merge).toBe(false);
    expect(d.failingRules).toEqual(["geography"]);
    expect(d.reason).toContain("geography (missing region(s) US; listing covers US-CA)");
  });

  it("annual-only fails resolution for both monthly and quarterly needs", async () => {
    const d = checkMerge({ listing: await listing(ANNUAL), requests: [AGENT_A, AGENT_B], now: NOW });
    expect(d.failingRules).toEqual(["resolution"]);
    expect(d.reason).toContain("annual cannot roll down to monthly (req-a)");
    expect(d.reason).toContain("annual cannot roll down to quarterly (req-b)");
  });

  it("the 2021-2022 set fails dates (and freshness is still reported)", async () => {
    const d = checkMerge({ listing: await listing(OLD), requests: [AGENT_A, AGENT_B], now: NOW });
    expect(d.failingRules).toContain("dates");
    expect(d.reason).toContain("req-a needs 2024-01-01..2026-09-30, listing covers 2021-01-01..2022-12-31");
    expect(d.checks).toHaveLength(MERGE_RULES.length);
  });

  it("a single-user, one-seat license fails license", async () => {
    const d = checkMerge({ listing: await listing(SINGLE_USER), requests: [AGENT_A, AGENT_B], now: NOW });
    expect(d.failingRules).toEqual(["license"]);
    expect(d.reason).toContain("license is single-user");
    expect(d.reason).toContain("1 seat(s) for 2 agents");
  });

  it("an unclear license means no merge", async () => {
    const unclear = { ...(await listing(NATIONAL)), id: "listing-unclear", license: "unclear" as const };
    const d = checkMerge({ listing: unclear, requests: [AGENT_A, AGENT_B], now: NOW });
    expect(d.failingRules).toEqual(["license"]);
    expect(d.reason).toContain("unclear license: no merge");
  });

  it("no saving over separate purchases fails price, and a cap breach is named per request", async () => {
    const standalone = new Map([
      ["req-a", await listing(CALIFORNIA)],
      ["req-b", await listing(NATIONAL)],
    ]);
    const pricey = { ...(await listing(NATIONAL)), id: "listing-pricey", priceAtomic: "23000000" };
    const d = checkMerge({ listing: pricey, requests: [AGENT_A, AGENT_B], standalone, now: NOW });
    expect(d.failingRules).toEqual(["price"]);
    expect(d.reason).toContain("23.00 USDC exceeds the combined caps 22.00 USDC (7.00 + 15.00)");
    expect(d.reason).toContain("no saving: one purchase 23.00 USDC vs 17.00 USDC separately");
  });

  it("every failing rule is reported, not only the first", async () => {
    const stale = { ...(await listing(CALIFORNIA)), id: "listing-stale", coverage: { ...(await listing(CALIFORNIA)).coverage, asOf: "2025-01-01", format: "json" as const } };
    const d = checkMerge({ listing: stale, requests: [AGENT_A, AGENT_B], now: NOW });
    expect(d.failingRules).toEqual(["geography", "format", "freshness"]);
  });
});
