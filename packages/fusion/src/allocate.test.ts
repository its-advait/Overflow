import { describe, expect, it } from "vitest";
import { allocate, AllocationError } from "./allocate";

const sum = (xs: { amountAtomic: string }[]): bigint => xs.reduce((a, x) => a + BigInt(x.amountAtomic), 0n);
const research = (weight: bigint | string) => ({ agentId: "agent-research", department: "research", weight });
const finance = (weight: bigint | string) => ({ agentId: "agent-finance", department: "finance", weight });
const ops = (weight: bigint | string) => ({ agentId: "agent-ops", department: "ops", weight });

describe("allocate: largest-remainder integer shares", () => {
  it("12 USDC at 70/30 books 8.40 and 3.60", () => {
    expect(allocate("12000000", [research(70n), finance(30n)])).toEqual([
      { agentId: "agent-research", department: "research", amountAtomic: "8400000" },
      { agentId: "agent-finance", department: "finance", amountAtomic: "3600000" },
    ]);
  });

  it("awkward splits still sum exactly: 10 USDC three ways", () => {
    const out = allocate("10000000", [research(1n), finance(1n), ops(1n)]);
    expect(out.map((a) => a.amountAtomic)).toEqual(["3333333", "3333334", "3333333"]) // tie: agent-finance sorts first;
    expect(sum(out)).toBe(10000000n);
  });

  it("the leftover units go to the largest remainders, ties by agentId", () => {
    expect(allocate(7n, [ops(1n), research(1n), finance(1n)]).map((a) => a.amountAtomic)).toEqual(["2", "2", "3"]);
    expect(allocate(1n, [research(1n), finance(1n)]).map((a) => a.amountAtomic)).toEqual(["0", "1"]);
  });

  it("weights as atomic strings, a zero weight gets nothing, totals are exact", () => {
    const out = allocate("12000000", [research("7000000"), finance("15000000"), ops("0")]);
    expect(out.map((a) => a.amountAtomic)).toEqual(["3818182", "8181818", "0"]);
    expect(sum(out)).toBe(12000000n);
  });

  it("rejects empty shares, all-zero weights and negative weights", () => {
    expect(() => allocate("1", [])).toThrow(AllocationError);
    expect(() => allocate("1", [research(0n)])).toThrow(AllocationError);
    expect(() => allocate("1", [research(-1n)])).toThrow(AllocationError);
  });
});
