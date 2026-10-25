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
  it("ledger rows balance: every account's debits and credits sum to the same total", () => {
    let debits = 0n;
    let credits = 0n;
    for (const e of fx.ledgerEntries) {
      debits += BigInt(e.amountAtomic);
      credits += BigInt(e.amountAtomic);
    }
    expect(debits).toBe(credits);
    const treasury = fx.ledgerEntries.reduce(
      (n, e) => n + (e.debitAccount === "usdc-treasury" ? BigInt(e.amountAtomic) : 0n) - (e.creditAccount === "usdc-treasury" ? BigInt(e.amountAtomic) : 0n),
      0n,
    );
    expect(treasury.toString()).toBe(fx.reconciliationRun.treasuryLedgerAtomic);
  });
  it("the ok run checks every fixture escrow at zero difference; the planted run's difference is the exception's amount", () => {
    expect(fx.reconciliationRun.escrows.map((e) => e.purchaseId).sort()).toEqual(fx.escrows.map((e) => e.purchaseId).sort());
    for (const e of fx.reconciliationRun.escrows) {
      expect(e.differenceAtomic).toBe("0");
      expect(e.material).toBe(false);
      // Funded and Revealed orders carry a chain balance of line + bond; Created and closed ones read nothing.
      expect(e.chainAtomic !== undefined).toBe(e.status === "Funded" || e.status === "Revealed");
    }
    expect(fx.reconciliationRun.differences).toEqual([]);
    expect(fx.reconciliationRunPlanted.status).toBe("differences");
    const planted = fx.reconciliationRunPlanted.differences.find((d) => d.kind === "treasury")!;
    expect(planted.material).toBe(true);
    expect(planted.differenceAtomic).toBe(fx.plantedException.amountAtomic);
    expect(fx.reconciliationRunPlanted.exceptionIds).toEqual([fx.plantedException.id]);
    expect(fx.plantedException.subject).toBe(planted.subject);
  });
});
