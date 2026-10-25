import { describe, expect, it } from "vitest";
import * as fx from "./fixtures";

describe("mock fixtures", () => {
  it("every purchase's allocations sum to its price", () => {
    for (const p of fx.purchases) {
      const sum = p.allocations.reduce((a, x) => a + BigInt(x.amountAtomic), 0n);
      expect(sum, p.id).toBe(BigInt(p.amountAtomic));
    }
  });
  it("has a merged and a refused Fusion outcome, the refused one naming its failing rule", () => {
    const refused = fx.fusionOutcomes.find((o) => !o.merge)!;
    expect(fx.fusionOutcomes.some((o) => o.merge)).toBe(true);
    expect(refused.failingRules).toEqual(["license"]);
    expect(refused.reason).toMatch(/^No merge of .* on res-cpi-california: license \(/);
    expect(refused.checks.filter((c) => !c.passed).map((c) => c.rule)).toEqual(["license"]);
  });
  it("every merge check carries evidence and the decisions end with the no-payment sentence", () => {
    for (const o of fx.fusionOutcomes) expect(o.checks).toHaveLength(9);
    for (const d of fx.oracleDecisions) expect(d.summary.endsWith("This is a recommendation; it authorizes no payment.")).toBe(true);
  });
});
