import { describe, expect, it } from "vitest";
import * as fx from "../mocks/fixtures";
import { comparisonRows, scoreInputs } from "./oracle";

describe("Oracle view model", () => {
  it("scoreInputs matches rank.ts: 1 region + 3 fields + 3 = 7; floor(12000000 / 7)", () => {
    const request = fx.requestById("req-finance-cpi")!;
    const national = fx.resources.find((r) => r.id === "res-cpi-national")!;
    expect(scoreInputs(request, national)).toEqual({ coveredRequirements: 7, pricePerCoveredAtomic: "1714285" });
  });
  it("orders rows chosen, alternatives, rejected and scores only ranked rows when the request is known", () => {
    const decision = fx.oracleDecisions.find((d) => d.requestId === "req-finance-cpi")!;
    const rows = comparisonRows(decision, fx.resources, fx.requestById("req-finance-cpi"));
    expect(rows[0]).toMatchObject({ listingId: "res-cpi-national", rank: 1, verdict: { kind: "chosen" } });
    expect(rows[0]!.score?.pricePerCoveredAtomic).toBe("1714285");
    expect(rows.slice(1).every((r) => r.verdict.kind === "rejected" && r.score === undefined)).toBe(true);
    expect(comparisonRows(decision, fx.resources)[0]!.score).toBeUndefined();
  });
  it("a decision with no chosen listing has only rejected rows", () => {
    const decision = fx.oracleDecisions.find((d) => d.requestId === "req-research-cpi")!;
    expect(comparisonRows(decision, fx.resources).every((r) => r.verdict.kind === "rejected")).toBe(true);
  });
});
