import { loadCatalog } from "@overflow/datasets";
import { describe, expect, it } from "vitest";
import { allocate } from "./allocate";
import { AGENT_A, AGENT_B, CALIFORNIA, NATIONAL, NOW, SINGLE_USER } from "./fixtures.test-helper";
import { fuse } from "./fuse";
import type { FusionListing } from "./types";

const catalogPromise = loadCatalog();
const pick = async (...ids: string[]): Promise<FusionListing[]> => {
  const { listings } = await catalogPromise;
  return ids.map((id) => listings.find((l) => l.id === id)!);
};

describe("fuse: the spec's acceptance tests at package level", () => {
  it("overlapping, compatible requests give one purchase with two allocations that sum to the price", async () => {
    const [california, national, sellerB] = await pick(CALIFORNIA, NATIONAL, "listing-national-monthly-2024-2026-seller-b");
    const result = fuse({
      requests: [AGENT_A, AGENT_B],
      survivors: new Map([
        ["req-a", [california!, national!]], // A could buy either; California is cheaper alone
        ["req-b", [national!, sellerB!]],
      ]),
      standalone: new Map([
        ["req-a", california],
        ["req-b", national],
      ]),
      now: NOW,
    });
    expect(result.merges).toHaveLength(1);
    const d = result.merges[0]!;
    expect(d).toMatchObject({ listingId: NATIONAL, merge: true, requestIds: ["req-a", "req-b"], failingRules: [] });
    expect(result.mergedRequestIds).toEqual(new Set(["req-a", "req-b"]));
    const allocations = allocate(national!.priceAtomic, [
      { agentId: AGENT_A.agentId, department: "research", weight: AGENT_A.maxPriceAtomic },
      { agentId: AGENT_B.agentId, department: "finance", weight: AGENT_B.maxPriceAtomic },
    ]);
    expect(allocations.reduce((s, a) => s + BigInt(a.amountAtomic), 0n)).toBe(12000000n);
    expect(allocations).toHaveLength(2);
  });

  it("same topic, incompatible geography gives no merge and names the rule", async () => {
    const [california, national] = await pick(CALIFORNIA, NATIONAL);
    // A's cap is below the national price, so nothing is acceptable to both.
    const poorA = { ...AGENT_A, maxPriceAtomic: "6000000" };
    const result = fuse({
      requests: [poorA, AGENT_B],
      survivors: new Map([
        ["req-a", [california!]],
        ["req-b", [national!]],
      ]),
      standalone: new Map([
        ["req-a", california],
        ["req-b", national],
      ]),
      now: NOW,
    });
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0]!.merge).toBe(false);
    expect(result.merges[0]!.listingId).toBe(CALIFORNIA);
    expect(result.merges[0]!.failingRules).toEqual(["identity", "geography"]);
    expect(result.merges[0]!.reason).toContain("geography (missing region(s) US");
    expect(result.mergedRequestIds.size).toBe(0);
  });

  it("the same dataset with a single-user license gives no merge", async () => {
    const [single] = await pick(SINGLE_USER);
    const a = { ...AGENT_A, regions: ["US"], license: "single-user" as const, maxPriceAtomic: "15000000" };
    const b = { ...AGENT_B, license: "single-user" as const };
    const result = fuse({ requests: [a, b], survivors: new Map([["req-a", [single!]], ["req-b", [single!]]]), now: NOW });
    expect(result.merges[0]).toMatchObject({ listingId: SINGLE_USER, merge: false, failingRules: ["license"] });
    expect(result.merges[0]!.reason).toContain("1 seat(s) for 2 agents");
  });

  it("two compatible requests still merge when a third in the group does not fit", async () => {
    const [california, national] = await pick(CALIFORNIA, NATIONAL);
    const c = { ...AGENT_B, id: "req-c", agentId: "agent-ops", topic: "EV registrations Texas", format: ["json" as const] };
    const result = fuse({
      requests: [AGENT_A, AGENT_B, c],
      survivors: new Map([
        ["req-a", [california!, national!]],
        ["req-b", [national!]],
        ["req-c", []],
      ]),
      standalone: new Map([
        ["req-a", california],
        ["req-b", national],
      ]),
      now: NOW,
    });
    expect(result.merges.map((m) => [m.requestIds, m.merge])).toEqual([[["req-a", "req-b"], true]]);
  });

  it("nothing to fuse when no topics overlap", () => {
    const steel = { ...AGENT_B, id: "req-s", topic: "Steel prices" };
    expect(fuse({ requests: [AGENT_A, steel], survivors: new Map(), now: NOW })).toEqual({ merges: [], mergedRequestIds: new Set() });
  });
});
