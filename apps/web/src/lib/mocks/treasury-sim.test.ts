import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { SIM_PAYEES, TreasurySim } from "./treasury-sim";

const USDC = (whole: number, cents = 0): bigint => BigInt(whole) * 1_000_000n + BigInt(cents) * 10_000n;

describe("SIMULATED treasury", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with a three-level tree whose spent amounts are consistent with the ancestor walk", () => {
    const sim = new TreasurySim();
    const snap = sim.snapshot();
    expect(snap.simulated).toBe(true);
    expect(snap.nodes.map((n) => [n.id, n.parent, n.depth])).toEqual([
      [1, 0, 0],
      [2, 1, 1],
      [3, 1, 1],
      [4, 3, 2],
      [5, 2, 2],
    ]);
    const by = Object.fromEntries(snap.nodes.map((n) => [n.id, n]));
    expect(BigInt(by[1]!.spent)).toBe(BigInt(by[2]!.spent) + BigInt(by[3]!.spent));
    expect(by[4]).toMatchObject({ status: "running", remaining: "7500000", payees: { mode: "restricted", known: [SIM_PAYEES.scrape] } });
    expect(by[4]!.agent).toMatchObject({ id: "agent-research-scraper" });
    expect(by[1]!.payees.mode).toBe("global");
    expect(snap.allowlist).toHaveLength(2);
  });

  it("a grandchild's payment charges itself, its parent and the root, and emits one labelled Paid event", () => {
    const sim = new TreasurySim();
    const before = sim.snapshot();
    const spent = (id: number, s = before) => BigInt(s.nodes.find((n) => n.id === id)!.spent);
    const event = sim.pay(4, SIM_PAYEES.scrape, USDC(1, 30));
    expect(event).toMatchObject({ kind: "treasury.paid", simulated: true, agentId: "agent-research-scraper" });
    const after = sim.snapshot();
    expect(spent(4, after) - spent(4)).toBe(USDC(1, 30));
    expect(spent(3, after) - spent(3)).toBe(USDC(1, 30));
    expect(spent(1, after) - spent(1)).toBe(USDC(1, 30));
    expect(spent(2, after) - spent(2)).toBe(0n);
    expect(spent(5, after) - spent(5)).toBe(0n);
    const payments = sim.paymentsOf(4);
    expect(payments.simulated).toBe(true);
    expect(payments.payments).toHaveLength(1);
    expect(payments.payments[0]).toMatchObject({ nodeId: 4, to: SIM_PAYEES.scrape, value: "1300000", simulated: true });
    expect(sim.paymentsOf(5).payments).toEqual([]);
  });

  it("refuses with the binding node's id and moves nothing: per-call, payee, budget", () => {
    const sim = new TreasurySim();
    const before = sim.snapshot();
    expect(sim.pay(5, SIM_PAYEES.search, USDC(3))).toMatchObject({ kind: "policy.blocked", decodedRevert: "OverPerCall(5)" });
    expect(sim.pay(4, SIM_PAYEES.attacker, USDC(0, 50))).toMatchObject({ decodedRevert: "PayeeNotAllowed(4)" });
    expect(sim.pay(4, SIM_PAYEES.search, USDC(0, 50))).toMatchObject({ decodedRevert: "PayeeNotAllowed(4)" }); // restricted: global allowlist does not apply
    expect(sim.pay(2, SIM_PAYEES.attacker, USDC(0, 50))).toMatchObject({ decodedRevert: "PayeeNotAllowed(2)" });
    expect(sim.snapshot().nodes.map((n) => n.spent)).toEqual(before.nodes.map((n) => n.spent));
    expect(sim.payments).toHaveLength(0);
    // Exhaust the scraper's own cap: 7.50 left, 2.00 per call max.
    for (let i = 0; i < 3; i++) expect(sim.pay(4, SIM_PAYEES.scrape, USDC(2)).kind).toBe("treasury.paid");
    expect(sim.pay(4, SIM_PAYEES.scrape, USDC(2))).toMatchObject({ decodedRevert: "OverBudget(4)" });
    expect(sim.snapshot().nodes.find((n) => n.id === 4)!.remaining).toBe("1500000");
  });

  it("never lets spent exceed cap on any node across many scripted ticks, and every event is simulated", () => {
    const sim = new TreasurySim();
    for (let i = 0; i < 400; i++) sim.tick();
    for (const n of sim.snapshot().nodes) expect(BigInt(n.spent) <= BigInt(n.cap)).toBe(true);
    expect(sim.events.every((e) => e.simulated)).toBe(true);
    expect(sim.events.some((e) => e.decodedRevert?.startsWith("OverBudget("))).toBe(true);
    expect(sim.events.some((e) => e.decodedRevert === "PayeeNotAllowed(4)")).toBe(true);
    expect(sim.events.some((e) => e.decodedRevert === "OverPerCall(5)")).toBe(true);
  });

  it("pause: PENDING at once, DONE only after the simulated NodePaused event, then the subtree is paused and refuses", () => {
    const sim = new TreasurySim();
    const seen: string[] = [];
    sim.subscribe((e) => seen.push(e.kind));
    const r = sim.raise({ type: "PAUSE_REQUEST", requestedBy: "web-dashboard", reason: "demo", nodeId: 3, agentId: "agent-research" });
    expect(r.created).toBe(true);
    expect(r.request).toMatchObject({ status: "pending", action: { kind: "pause", nodeId: 3 } });
    expect(r.request!.txHash).toBeUndefined();
    expect(sim.snapshot().nodes.find((n) => n.id === 3)!.paused).toBe(false);
    // Duplicate while open: the same request, created: false.
    const again = sim.raise({ type: "PAUSE_REQUEST", requestedBy: "web-dashboard", reason: "demo again", nodeId: 3 });
    expect(again.created).toBe(false);
    expect(again.request?.id).toBe(r.request!.id);
    expect(sim.requests).toHaveLength(1);

    vi.advanceTimersByTime(3_999);
    expect(sim.request(r.request!.id)!.status).toBe("pending");
    vi.advanceTimersByTime(1);
    const done = sim.request(r.request!.id)!;
    expect(done.status).toBe("done");
    expect(done.txHash).toMatch(/^0x51a0/);
    expect(seen).toEqual(["controller.requested", "treasury.node", "controller.resolved"]);
    const by = Object.fromEntries(sim.snapshot().nodes.map((n) => [n.id, n]));
    expect(by[3]).toMatchObject({ paused: true, status: "paused", pausedBy: 3 });
    expect(by[4]).toMatchObject({ paused: false, status: "paused", pausedBy: 3 }); // greyed with its parent
    expect(by[2]!.status).toBe("running");
    expect(sim.pay(4, SIM_PAYEES.scrape, USDC(0, 50))).toMatchObject({ decodedRevert: "Paused(3)" });
    expect(sim.exceptions[0]).toMatchObject({ status: "resolved", decision: "approve" });
    // A new pause request for the same node can open again once the previous one resolved.
    expect(sim.raise({ type: "PAUSE_REQUEST", requestedBy: "web-dashboard", reason: "x", nodeId: 3 }).created).toBe(true);
  });

  it("raise cap and add payee change state only on approval; unknown node is 404", () => {
    const sim = new TreasurySim();
    const cap = sim.raise({ type: "CAP_RAISE", requestedBy: "web-dashboard", reason: "more", nodeId: 4, newCapAtomic: "20000000" });
    const payee = sim.raise({ type: "NEW_PAYEE", requestedBy: "web-dashboard", reason: "new seller", payee: SIM_PAYEES.attacker });
    expect(sim.snapshot().nodes.find((n) => n.id === 4)!.cap).toBe("10000000");
    expect(sim.snapshot().allowlist).not.toContain(SIM_PAYEES.attacker);
    vi.advanceTimersByTime(4_000);
    expect(sim.request(cap.request!.id)!.status).toBe("done");
    expect(sim.request(payee.request!.id)!.status).toBe("done");
    expect(sim.snapshot().nodes.find((n) => n.id === 4)!.cap).toBe("20000000");
    expect(sim.snapshot().allowlist).toContain(SIM_PAYEES.attacker);
    expect(sim.pay(2, SIM_PAYEES.attacker, USDC(0, 50)).kind).toBe("treasury.paid");
    expect(() => sim.raise({ type: "PAUSE_REQUEST", requestedBy: "x", reason: "y", nodeId: 99 })).toThrow(ApiError);
  });

  it("start() ticks on the interval and stop() ends it and drops pending approvals", () => {
    const sim = new TreasurySim({ tickMs: 1_000, approvalMs: 500 });
    sim.start();
    sim.start();
    vi.advanceTimersByTime(3_000);
    expect(sim.events.length).toBe(3);
    const r = sim.raise({ type: "PAUSE_REQUEST", requestedBy: "x", reason: "y", nodeId: 5 });
    sim.stop();
    vi.advanceTimersByTime(5_000);
    expect(sim.events.length).toBe(4); // only the controller.requested event
    expect(sim.request(r.request!.id)!.status).toBe("pending");
  });
});
