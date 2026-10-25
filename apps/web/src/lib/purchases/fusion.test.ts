import { MERGE_RULES } from "@overflow/fusion";
import { describe, expect, it } from "vitest";
import * as fx from "../mocks/fixtures";
import { avoidedDuplicateCost, RULE_LABELS } from "./fusion";

describe("avoidedDuplicateCost", () => {
  it("merged outcome: 12 + 12 separately (research had no standalone pick) vs 12 merged", () => {
    const merged = fx.fusionOutcomes.find((o) => o.merge)!;
    const cost = avoidedDuplicateCost(merged, fx.oracleDecisions, fx.resources)!;
    expect(cost.mergedAtomic).toBe(12_000_000n);
    expect(cost.separateAtomic).toBe(24_000_000n);
    expect(cost.savedAtomic).toBe(12_000_000n);
    expect(cost.parts.map((p) => p.listingId)).toEqual(["res-cpi-national", "res-cpi-national"]);
  });
  it("refused outcome and missing listing give null", () => {
    const refused = fx.fusionOutcomes.find((o) => !o.merge)!;
    expect(avoidedDuplicateCost(refused, fx.oracleDecisions, fx.resources)).toBeNull();
    const merged = fx.fusionOutcomes.find((o) => o.merge)!;
    expect(avoidedDuplicateCost(merged, fx.oracleDecisions, [])).toBeNull();
  });
  it("labels every merge rule", () => {
    for (const rule of MERGE_RULES) expect(RULE_LABELS[rule].title.length).toBeGreaterThan(0);
  });
});
