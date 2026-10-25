import { loadCatalog } from "@overflow/datasets";
import type { Hex } from "@overflow/schemas";
import { describe, expect, it } from "vitest";
import { filterByCoverage } from "./coverage";
import { NATIONAL_MONTHLY } from "./fixtures.test-helper";
import { rank } from "./rank";
import { recommend } from "./recommend";
import type { IdentifiedListing } from "./types";

const catalogPromise = loadCatalog();
const NOW = new Date("2026-10-24T16:00:00Z");

function listing(id: string, priceAtomic: string, asOf: string | undefined): IdentifiedListing {
  return {
    id,
    sellerId: "sim-seller-x",
    productId: id,
    coverage: {
      regions: ["US"],
      dateRange: { start: "2024-01-01", end: "2026-09-30" },
      granularity: "monthly",
      fields: ["brand", "units", "state"],
      format: "csv",
      ...(asOf ? { asOf } : {}),
    },
    license: "company-use",
    priceAtomic,
    manifestHash: `0x${id.length.toString(16).padStart(2, "0").repeat(32)}` as Hex,
    seats: 10,
    simulated: true,
  };
}

describe("rank", () => {
  it("orders the national survivors by price per covered requirement with the inputs shown", async () => {
    const { listings } = await catalogPromise;
    const survivors = filterByCoverage(NATIONAL_MONTHLY, listings).accepted;
    const ranked = rank(survivors, NATIONAL_MONTHLY);
    expect(ranked.map((r) => r.listing.id)).toEqual([
      "listing-national-monthly-2024-2026-single-user", // 10 USDC
      "listing-national-monthly-2024-2026", // 12 USDC
      "listing-national-monthly-2024-2026-seller-b", // 13 USDC
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    // 1 region + 3 fields + dates + granularity + format = 7 covered requirements.
    expect(ranked[1]!.inputs).toEqual({
      priceAtomic: "12000000",
      coveredRequirements: 7,
      pricePerCoveredAtomic: "1714285",
      asOf: "2026-10-15",
    });
  });

  it("is deterministic regardless of input order", async () => {
    const { listings } = await catalogPromise;
    const survivors = filterByCoverage(NATIONAL_MONTHLY, listings).accepted;
    const reference = rank(survivors, NATIONAL_MONTHLY).map((r) => r.listing.id);
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const p of permutations) {
      const shuffled = p.map((i) => survivors[i]!);
      expect(rank(shuffled, NATIONAL_MONTHLY).map((r) => r.listing.id)).toEqual(reference);
    }
  });

  it("breaks price ties on freshness (newer first, missing asOf last), then on id", () => {
    const a = listing("a-old", "5000000", "2026-01-01");
    const b = listing("b-new", "5000000", "2026-10-01");
    const c = listing("c-none", "5000000", undefined);
    const d = listing("d-new-twin", "5000000", "2026-10-01");
    const order = rank([c, a, d, b], NATIONAL_MONTHLY).map((r) => r.listing.id);
    expect(order).toEqual(["b-new", "d-new-twin", "a-old", "c-none"]);
  });

  it("uses exact integer arithmetic for the per-requirement price", () => {
    const only = listing("one", "1", "2026-10-01");
    const [r] = rank([only], NATIONAL_MONTHLY);
    expect(r!.inputs.pricePerCoveredAtomic).toBe("0");
    expect(typeof r!.inputs.priceAtomic).toBe("string");
  });
});

describe("recommend (full pipeline) on the P5.1 catalog", () => {
  it("chooses the 12 USDC national set, explains every rejection and labels the result simulated", async () => {
    const { listings } = await catalogPromise;
    const result = recommend({
      request: { ...NATIONAL_MONTHLY, maxPriceAtomic: "12500000" },
      listings,
      now: NOW,
      assumptions: ["the model's text preferred the cheaper 2021-2022 set"],
    });
    expect(result.explanation.chosen?.listingId).toBe("listing-national-monthly-2024-2026");
    expect(result.explanation.chosen?.priceAtomic).toBe("12000000");
    expect(result.explanation.alternatives).toHaveLength(0);
    const rejectedIds = result.explanation.rejected.map((r) => r.listingId);
    expect(rejectedIds.sort()).toEqual([
      "listing-california-monthly-2024-2026",
      "listing-national-annual-2024-2026",
      "listing-national-monthly-2021-2022",
      "listing-national-monthly-2024-2026-seller-b",
      "listing-national-monthly-2024-2026-single-user",
    ]);
    const stale = result.explanation.rejected.find((r) => r.listingId === "listing-national-monthly-2021-2022")!;
    expect(stale.reasons.map((x) => x.reason)).toEqual(["dateRange"]);
    expect(result.explanation.simulated).toBe(true);
    expect(result.explanation.summary).toContain("Chose listing-national-monthly-2024-2026");
    expect(result.explanation.summary).toContain("Rejected listing-national-monthly-2021-2022: dateRange");
    expect(result.explanation.summary).toContain("Assumption: the model's text preferred");
    expect(result.explanation.summary).toContain("authorizes no payment");
  });

  it("returns no choice when nothing survives", async () => {
    const { listings } = await catalogPromise;
    const result = recommend({ request: { ...NATIONAL_MONTHLY, regions: ["US-HI"] }, listings, now: NOW });
    expect(result.ranked).toHaveLength(0);
    expect(result.explanation.chosen).toBeNull();
    expect(result.explanation.summary).toContain("No listing satisfies the request.");
  });
});
