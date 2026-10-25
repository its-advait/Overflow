import { ActivityKindSchema, type ActivityEvent } from "@overflow/schemas";
import { describe, expect, it } from "vitest";
import * as fx from "@/lib/mocks/fixtures";
import { createMockApi } from "@/lib/api/mock";
import {
  blockedEvents,
  countByFamily,
  describeEvent,
  digestOf,
  familyOf,
  filterActivity,
  groupOf,
  matchesFilter,
  mergeLive,
  parseModelCall,
  parseMoney,
  parseSourceRefs,
  refusalEvidence,
  serverQueryFor,
  TYPE_GROUP_ORDER,
  TYPE_GROUPS,
} from "./index";

const D = `0x${"d1".repeat(32)}`;
const ev = (over: Partial<ActivityEvent> & Pick<ActivityEvent, "id" | "kind">): ActivityEvent => ({ at: "2026-10-25T00:00:00.000Z", message: "", simulated: false, ...over });

describe("type groups", () => {
  it("put every activity kind in exactly one group", () => {
    const all = TYPE_GROUP_ORDER.flatMap((g) => [...TYPE_GROUPS[g]]);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...ActivityKindSchema.options].sort());
    expect(groupOf("policy.blocked")).toBe("blocked");
    expect(groupOf("oracle.model_call")).toBe("decisions");
    expect(groupOf("escrow.settled")).toBe("escrow");
  });
});

describe("filters", () => {
  it("mirror the service's mission, agent and type narrowing, combined", () => {
    const research = filterActivity(fx.activity, { agentId: "agent-research" });
    expect(research.length).toBeGreaterThan(0);
    expect(research.every((e) => e.agentId === "agent-research")).toBe(true);
    const blocked = filterActivity(fx.activity, { missionId: fx.mission.id, agentId: "agent-research", group: "blocked" });
    expect(blocked.map((e) => e.id).sort()).toEqual(["ev-11", "ev-20"]);
    // The bypass has no mission and no agent: a mission filter hides it, the unfiltered lane shows it.
    expect(filterActivity(fx.activity, { missionId: fx.mission.id }).some((e) => e.id === "ev-21")).toBe(false);
    expect(matchesFilter(fx.activity.find((e) => e.id === "ev-21")!, {})).toBe(true);
  });

  it("send one scope and the kind to the service", () => {
    expect(serverQueryFor({})).toEqual({ limit: 500 });
    expect(serverQueryFor({ missionId: "m1", agentId: "a1" })).toEqual({ limit: 500, missionId: "m1" });
    expect(serverQueryFor({ agentId: "a1" }, true)).toEqual({ limit: 500, agentId: "a1", kind: "policy.blocked" });
    expect(serverQueryFor({ group: "blocked" })).toEqual({ limit: 500, kind: "policy.blocked" });
  });

  it("merge live frames by id, newest first", () => {
    const a = ev({ id: "a", kind: "mission.run", at: "2026-10-25T00:00:01.000Z" });
    const b = ev({ id: "b", kind: "mission.run", at: "2026-10-25T00:00:02.000Z" });
    const a2 = { ...a, message: "updated" };
    const merged = mergeLive([a], [b, a2]);
    expect(merged.map((e) => e.id)).toEqual(["b", "a"]);
    expect(merged[1]!.message).toBe("updated");
    const tie = mergeLive([ev({ id: "x", kind: "mission.run" })], [ev({ id: "y", kind: "mission.run" })]);
    expect(tie.map((e) => e.id)).toEqual(["y", "x"]);
  });
});

describe("attribution", () => {
  it("reads the trailing source tokens the service writes", () => {
    const tool = parseSourceRefs(`treasury refused 0.05 USDC for http://localhost:4100/premium-intel: PayeeNotAllowed(0) (Recipient is not approved for anyone) [reverted onchain] [facilitator:${D}]`);
    expect(tool.flags).toEqual(["reverted onchain"]);
    expect(tool.refs).toEqual([{ kind: "facilitator", reference: D }]);
    expect(tool.text).toBe("treasury refused 0.05 USDC for http://localhost:4100/premium-intel: PayeeNotAllowed(0) (Recipient is not approved for anyone)");
    const rejected = parseSourceRefs("FUNDED -> REJECTED: OverBudget(3) [adapter:recourse-anvil-runner]");
    expect(rejected.refs).toEqual([{ kind: "adapter", reference: "recourse-anvil-runner" }]);
    expect(parseSourceRefs("Paid(4): 1.00 USDC to 0xabc [MOCK SIMULATED]").flags).toEqual(["MOCK SIMULATED"]);
    expect(parseSourceRefs("no tokens here").refs).toEqual([]);
    expect(digestOf(`x [facilitator:${D}]`)).toBe(D);
    expect(digestOf("x [facilitator:not-a-digest]")).toBeUndefined();
  });

  it("reads the oracle's model-call hashes", () => {
    const call = parseModelCall(fx.activity.find((e) => e.kind === "oracle.model_call")!);
    expect(call).toMatchObject({ attempt: 1, model: "claude-sonnet-5-5", outcome: "parsed" });
    expect(call?.promptHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(parseModelCall(ev({ id: "x", kind: "agent.report", message: "promptHash=0x00" }))).toBeUndefined();
  });

  it("parses amounts with integer math and the counterparty the message names", () => {
    expect(parseMoney("Paid(4): 12.00 USDC to 0x5e11e20100000000000000000000000000000000 signed by scraper")).toEqual({
      amountAtomic: "12000000",
      counterparty: { kind: "address", value: "0x5e11e20100000000000000000000000000000000" },
    });
    expect(parseMoney("treasury refused 0.05 USDC for http://localhost:4100/premium-intel: PayeeNotAllowed(0)")).toEqual({
      amountAtomic: "50000",
      counterparty: { kind: "url", value: "http://localhost:4100/premium-intel" },
    });
    expect(parseMoney("0.000001 USDC")).toEqual({ amountAtomic: "1" });
    expect(parseMoney("mission run started")).toEqual({});
  });

  it("takes a purchase-linked event's seller and amount from the stored purchase", () => {
    const blocked = fx.activity.find((e) => e.id === "ev-11")!;
    const d = describeEvent(blocked, { agents: fx.agents, purchases: fx.purchases, resources: fx.resources });
    const purchase = fx.purchases.find((p) => p.id === "pur-freight-retry")!;
    expect(d.purchase?.id).toBe(purchase.id);
    expect(d.amountAtomic).toBe(purchase.amountAtomic);
    expect(d.counterparty).toMatchObject({ kind: "seller", value: purchase.sellerAddress });
    expect(d.agent).toMatch(/·/);
    const bypass = describeEvent(fx.activity.find((e) => e.id === "ev-21")!, { agents: fx.agents });
    expect(bypass.agent).toBeUndefined();
    expect(bypass.amountAtomic).toBeUndefined();
    expect(bypass.action).not.toMatch(/\[facilitator:/);
  });
});

describe("refusal evidence", () => {
  const find = (id: string) => fx.activity.find((e) => e.id === id)!;

  it("names the injection's global allowlist revert, onchain, with its digest and tx", () => {
    const r = refusalEvidence(find("ev-20"));
    expect(r).toMatchObject({ name: "PayeeNotAllowed", args: ["0"], family: "PayeeNotAllowed", stage: "reverted onchain", reason: "Recipient isn't approved for anyone", simulated: true });
    expect(r.txHash).toBe(find("ev-20").txHash);
    expect(r.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.bindingNode).toBeNull();
  });

  it("calls the bypass a USDC rejection", () => {
    const r = refusalEvidence(find("ev-21"));
    expect(r.family).toBe("USDC bypass");
    expect(r.stage).toBe("rejected by USDC");
    expect(r.reason).toMatch(/only valid inside treasury.settle\(\)/);
    expect(familyOf("FiatTokenV2: invalid signature")).toBe("USDC bypass");
  });

  it("tells a cap revert, a client refusal and a simulated refusal apart", () => {
    expect(refusalEvidence(find("ev-11"))).toMatchObject({ family: "OverBudget", stage: "refused in simulation", bindingNode: 3, reason: "Agent 3 or an ancestor would pass its cap" });
    expect(refusalEvidence(find("ev-22"))).toMatchObject({ family: "QuoteMismatch", stage: "refused before signing" });
    expect(refusalEvidence(find("ev-23"))).toMatchObject({ family: "PayeeFlagged", stage: "refused in simulation", reason: "Seller has a proven cheat on record" });
    expect(familyOf("ChildExceedsParent()")).toBe("Delegation");
    expect(familyOf("payment_blocked")).toBe("Other");
    expect(familyOf(undefined)).toBe("Other");
  });

  it("lists the lane newest first and counts by family", () => {
    const lane = blockedEvents(fx.activity);
    expect(lane.map((e) => e.id)).toEqual(["ev-23", "ev-11", "ev-22", "ev-21", "ev-20"]);
    expect(countByFamily(lane)).toEqual([
      { family: "PayeeNotAllowed", count: 1 },
      { family: "USDC bypass", count: 1 },
      { family: "OverBudget", count: 1 },
      { family: "PayeeFlagged", count: 1 },
      { family: "QuoteMismatch", count: 1 },
    ]);
  });
});

describe("mock api", () => {
  it("narrows by kind like the service", async () => {
    const api = createMockApi();
    const { events } = await api.listActivity({ kind: "policy.blocked", limit: 500 });
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(events.every((e) => e.kind === "policy.blocked")).toBe(true);
    const research = await api.listActivity({ kind: "policy.blocked", agentId: "agent-research", limit: 500 });
    expect(research.events.map((e) => e.id).sort()).toEqual(expect.arrayContaining(["ev-11", "ev-20"]));
  });
});
