import type { ActivityEvent, ControllerRequest } from "@overflow/schemas";
import { describe, expect, it } from "vitest";
import { ancestorsOf, barPercent, bindingNodeOf, buildNodeTree, deriveStatus, expiryCountdown, nodeRequests, refusalsFor, remainingOf } from "./tree";

const FAR = 4_000_000_000n;
const n = (id: number, parent: number, over: Partial<{ paused: boolean; expiry: bigint; cap: bigint; spent: bigint }> = {}) => ({
  id,
  parent,
  paused: false,
  expiry: FAR,
  cap: 100n,
  spent: 0n,
  ...over,
});
const asMap = <T extends { id: number }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));

describe("buildNodeTree", () => {
  it("nests children under parents by id order and treats parent 0 or an unknown parent as a root", () => {
    const roots = buildNodeTree([n(3, 1), n(1, 0), n(2, 1), n(5, 3), n(9, 42)]);
    expect(roots.map((r) => r.node.id)).toEqual([1, 9]);
    expect(roots[0]!.children.map((c) => c.node.id)).toEqual([2, 3]);
    expect(roots[0]!.children[1]!.children.map((c) => c.node.id)).toEqual([5]);
  });
});

describe("barPercent", () => {
  it("is bigint math with two decimals, clamped, and 0 for an empty cap", () => {
    expect(barPercent("2500000", "10000000")).toBe(25);
    expect(barPercent(1n, 3n)).toBe(33.33);
    expect(barPercent(15n, 10n)).toBe(100);
    expect(barPercent(0n, 0n)).toBe(0);
    expect(barPercent(5n, 0n)).toBe(0);
  });
});

describe("deriveStatus / remainingOf", () => {
  const nodes = asMap([n(1, 0, { expiry: 1_000n, cap: 100n, spent: 90n }), n(2, 1, { paused: true, cap: 50n, spent: 5n }), n(3, 2, { cap: 20n, spent: 2n }), n(4, 1, { cap: 30n, spent: 0n })]);
  it("walks self then ancestors", () => {
    expect(ancestorsOf(nodes, 3).map((x) => x.id)).toEqual([3, 2, 1]);
  });
  it("paused wins over expired and names the nearest cause; a child of a paused node is paused by it", () => {
    expect(deriveStatus(nodes, 3, 2_000)).toEqual({ status: "paused", pausedBy: 2, expiredBy: 1 });
    expect(deriveStatus(nodes, 4, 2_000)).toEqual({ status: "expired", pausedBy: null, expiredBy: 1 });
    expect(deriveStatus(nodes, 4, 500)).toEqual({ status: "running", pausedBy: null, expiredBy: null });
  });
  it("remaining is the smallest cap - spent over the walk (the root binds the grandchild)", () => {
    expect(remainingOf(nodes, 3)).toBe(10n); // 18 vs 45 vs 10
    expect(remainingOf(nodes, 4)).toBe(10n);
    expect(remainingOf(asMap([n(1, 0, { cap: 5n, spent: 9n })]), 1)).toBe(0n);
  });
});

describe("expiryCountdown", () => {
  it("formats days, hours, minutes, seconds and expired", () => {
    expect(expiryCountdown(BigInt(1_000 + 2 * 86_400 + 3 * 3_600), 1_000)).toBe("2d 3h");
    expect(expiryCountdown(BigInt(1_000 + 2 * 3_600 + 5 * 60), 1_000)).toBe("2h 05m");
    expect(expiryCountdown(BigInt(1_000 + 4 * 60 + 9), 1_000)).toBe("4m 09s");
    expect(expiryCountdown(1_030n, 1_000)).toBe("30s");
    expect(expiryCountdown(1_000n, 1_000)).toBe("expired");
  });
});

describe("requests and refusals per node", () => {
  const req = (id: string, action: ControllerRequest["action"]): ControllerRequest => ({
    id,
    action,
    requestedBy: "web-dashboard",
    reason: "r",
    target: "0x1111111111111111111111111111111111111111",
    data: "0x00",
    value: "0",
    summary: "s",
    status: "pending",
    createdAt: "2026-10-25T00:00:00.000Z",
  });
  it("nodeRequests matches pause / raise-cap by nodeId and skips global actions", () => {
    const rs = [req("a", { kind: "pause", nodeId: 3 }), req("b", { kind: "raise-cap", nodeId: 1, newCapAtomic: "5" }), req("c", { kind: "set-allow", payee: "0x2222222222222222222222222222222222222222", allowed: true })];
    expect(nodeRequests(rs, 3).map((r) => r.id)).toEqual(["a"]);
    expect(nodeRequests(rs, 1).map((r) => r.id)).toEqual(["b"]);
    expect(nodeRequests(rs, 7)).toEqual([]);
  });
  it("bindingNodeOf reads the node id out of a decoded treasury revert", () => {
    expect(bindingNodeOf("OverBudget(1)")).toBe(1);
    expect(bindingNodeOf("Paused(12)")).toBe(12);
    expect(bindingNodeOf("BelowFloor()")).toBeNull();
    expect(bindingNodeOf("BadDelegation(0xabc)")).toBeNull();
    expect(bindingNodeOf(undefined)).toBeNull();
  });
  it("refusalsFor keeps the agent's own refusals and those bound by this node, newest first", () => {
    const ev = (id: string, at: string, over: Partial<ActivityEvent>): ActivityEvent => ({ id, at, kind: "policy.blocked", message: "m", simulated: false, ...over });
    const events = [
      ev("e1", "2026-10-25T00:00:01.000Z", { agentId: "agent-child", decodedRevert: "OverBudget(1)" }), // grandchild signed, root binds
      ev("e2", "2026-10-25T00:00:02.000Z", { agentId: "agent-root", decodedRevert: "OverPerCall(1)" }),
      ev("e3", "2026-10-25T00:00:03.000Z", { agentId: "agent-child", decodedRevert: "Paused(2)" }),
      ev("e4", "2026-10-25T00:00:04.000Z", { kind: "treasury.paid", agentId: "agent-root" }),
    ];
    expect(refusalsFor(events, { id: 1, agent: { id: "agent-root" } }).map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(refusalsFor(events, { id: 2, agent: { id: "agent-child" } }).map((e) => e.id)).toEqual(["e3", "e1"]);
    expect(refusalsFor(events, { id: 9, agent: null })).toEqual([]);
  });
});
