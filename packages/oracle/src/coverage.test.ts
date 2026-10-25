import { loadCatalog } from "@overflow/datasets";
import type { Hex } from "@overflow/schemas";
import { describe, expect, it } from "vitest";
import { filterByCoverage } from "./coverage";
import { NATIONAL_MONTHLY, NATIONAL_MONTHLY_COVERAGE } from "./fixtures.test-helper";
import { filterByTerms } from "./terms";

// P5.1 catalog: six SIMULATED listings, each built to fail exactly one rule.
const catalogPromise = loadCatalog();
const NOW = new Date("2026-10-24T16:00:00Z");

const reasonsFor = (rejected: { listingId: string; reason: string }[], id: string) =>
  rejected.filter((r) => r.listingId === id).map((r) => r.reason);

describe("filterByCoverage with the P5.1 catalog", () => {
  it("rejects the 2021-2022 dataset on dateRange even though it is the cheapest", async () => {
    const { listings } = await catalogPromise;
    const { accepted, rejected } = filterByCoverage(NATIONAL_MONTHLY, listings);
    expect(reasonsFor(rejected, "listing-national-monthly-2021-2022")).toEqual(["dateRange"]);
    expect(accepted.map((l) => l.id)).not.toContain("listing-national-monthly-2021-2022");
    const detail = rejected.find((r) => r.listingId === "listing-national-monthly-2021-2022")!.detail;
    expect(detail).toContain("2021-01-01..2022-12-31");
    expect(detail).toContain("2024-01-01..2026-09-30");
  });

  it("rejects California-only for a national request on region", async () => {
    const { listings } = await catalogPromise;
    const { rejected } = filterByCoverage(NATIONAL_MONTHLY, listings);
    expect(reasonsFor(rejected, "listing-california-monthly-2024-2026")).toEqual(["region"]);
  });

  it("rejects annual-only for a monthly request on granularity", async () => {
    const { listings } = await catalogPromise;
    const { rejected } = filterByCoverage(NATIONAL_MONTHLY, listings);
    expect(reasonsFor(rejected, "listing-national-annual-2024-2026")).toEqual(["granularity"]);
  });

  it("accepts the three national monthly 2024-2026 listings and nothing else", async () => {
    const { listings } = await catalogPromise;
    const { accepted } = filterByCoverage(NATIONAL_MONTHLY, listings);
    expect(accepted.map((l) => l.id).sort()).toEqual([
      "listing-national-monthly-2024-2026",
      "listing-national-monthly-2024-2026-seller-b",
      "listing-national-monthly-2024-2026-single-user",
    ]);
  });

  it("lets monthly roll up to a quarterly request but keeps annual out", async () => {
    const { listings } = await catalogPromise;
    const quarterly = { ...NATIONAL_MONTHLY, granularity: "quarterly" as const, dateRange: { start: "2025-01-01", end: "2026-09-30" } };
    const { accepted, rejected } = filterByCoverage(quarterly, listings);
    expect(accepted.map((l) => l.id)).toContain("listing-national-monthly-2024-2026");
    expect(reasonsFor(rejected, "listing-national-annual-2024-2026")).toEqual(["granularity"]);
  });

  it("accepts the California listing for a California request", async () => {
    const { listings } = await catalogPromise;
    const california = { ...NATIONAL_MONTHLY, regions: ["US-CA"] };
    const { accepted } = filterByCoverage(california, listings);
    expect(accepted.map((l) => l.id)).toContain("listing-california-monthly-2024-2026");
    expect(accepted.map((l) => l.id)).toContain("listing-national-monthly-2024-2026");
  });

  it("reports every failing check per listing, including fields and format", async () => {
    const { listings } = await catalogPromise;
    const picky = { ...NATIONAL_MONTHLY, requiredFields: ["brand", "units", "Price"], format: ["parquet" as const] };
    const { accepted, rejected } = filterByCoverage(picky, listings);
    expect(accepted).toHaveLength(0);
    const stale = reasonsFor(rejected, "listing-national-monthly-2021-2022").sort();
    expect(stale).toEqual(["dateRange", "field", "format"]);
    const national = reasonsFor(rejected, "listing-national-monthly-2024-2026").sort();
    expect(national).toEqual(["field", "format"]);
  });

  it("matches fields case-insensitively", async () => {
    const { listings } = await catalogPromise;
    const upper = { ...NATIONAL_MONTHLY, requiredFields: ["Brand", "UNITS"] };
    expect(filterByCoverage(upper, listings).accepted.map((l) => l.id)).toContain("listing-national-monthly-2024-2026");
  });
});

describe("filterByTerms with the P5.1 catalog", () => {
  it("rejects the single-user listing for a company-use request and the 13 USDC listing over a 12.5 USDC cap", async () => {
    const { listings } = await catalogPromise;
    const survivors = filterByCoverage(NATIONAL_MONTHLY, listings).accepted;
    const { accepted, rejected } = filterByTerms({ ...NATIONAL_MONTHLY, maxPriceAtomic: "12500000" }, survivors, NOW);
    expect(accepted.map((l) => l.id)).toEqual(["listing-national-monthly-2024-2026"]);
    expect(reasonsFor(rejected, "listing-national-monthly-2024-2026-single-user")).toEqual(["license"]);
    expect(reasonsFor(rejected, "listing-national-monthly-2024-2026-seller-b")).toEqual(["price"]);
  });

  it("accepts company-use listings for a single-user request", async () => {
    const { listings } = await catalogPromise;
    const survivors = filterByCoverage(NATIONAL_MONTHLY, listings).accepted;
    const { accepted } = filterByTerms({ ...NATIONAL_MONTHLY, license: "single-user" }, survivors, NOW);
    expect(accepted).toHaveLength(3);
  });

  it("rejects on freshness when asOf (2026-10-15) is older than allowed", async () => {
    const { listings } = await catalogPromise;
    const survivors = filterByCoverage(NATIONAL_MONTHLY, listings).accepted;
    const { accepted, rejected } = filterByTerms(
      { ...NATIONAL_MONTHLY, license: "single-user", freshness: { maxAgeDays: 5 } },
      survivors,
      NOW,
    );
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(3);
    expect(rejected.every((r) => r.reason === "freshness")).toBe(true);
    expect(rejected[0]!.detail).toContain("9 days old");
  });

  it("never buys an unclear license", () => {
    const listing = {
      id: "l-unclear",
      sellerId: "s",
      productId: "p",
      coverage: NATIONAL_MONTHLY_COVERAGE,
      license: "unclear" as const,
      priceAtomic: "1000000",
      manifestHash: `0x${"ab".repeat(32)}` as Hex,
      seats: 1,
      simulated: true,
    };
    const { accepted, rejected } = filterByTerms({ ...NATIONAL_MONTHLY, license: "single-user" }, [listing], NOW);
    expect(accepted).toHaveLength(0);
    expect(rejected.map((r) => r.reason)).toEqual(["license"]);
  });
});
