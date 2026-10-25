import { describe, expect, it } from "vitest";
import type { EscrowActions, EscrowChainState } from "@overflow/schemas";
import * as fx from "../mocks/fixtures";
import { actionPreview, deriveDiagram, gateActions, liveDeadlines, mergeGates, nodeEvidence, txArg } from "./state";

const txsOf = (purchaseId: string) => fx.chainTransactions.filter((t) => t.purchaseId === purchaseId);
const e = (id: string) => fx.escrows.find((x) => x.id === id)!;

describe("deriveDiagram (fixtures)", () => {
  it("honest order: Settled lit, three done nodes with their logs, Refunded unreachable, the happy edges taken", () => {
    const d = deriveDiagram(e("esc-national"), null, txsOf("pur-merged-national"));
    expect(d.current).toBe("Settled");
    expect(d.source).toBe("stored");
    expect(Object.fromEntries(Object.values(d.nodes).map((n) => [n.status, n.state]))).toEqual({ Created: "done", Funded: "done", Revealed: "done", Settled: "current", Refunded: "unreachable" });
    expect(d.nodes.Created.evidence?.txHash).toBeDefined();
    expect(d.nodes.Funded.evidence?.txHash).toBe(txsOf("pur-merged-national").find((t) => t.eventName === "OrderFunded")!.txHash);
    expect(d.nodes.Settled.evidence?.txHash).toBe(txsOf("pur-merged-national").find((t) => t.eventName === "PaidOut")!.txHash);
    expect(d.edges.filter((x) => x.taken).map((x) => `${x.from}>${x.to}`)).toEqual(["Created>Funded", "Funded>Revealed", "Revealed>Settled"]);
    expect(d.refundOrigin).toBeUndefined();
  });
  it("ghost order: Refunded from Funded with reason timeout; Revealed and Settled unreachable", () => {
    const d = deriveDiagram(e("esc-freight"), null, txsOf("pur-freight-weekly"));
    expect(d.current).toBe("Refunded");
    expect(d.refundOrigin).toBe("Funded");
    expect(d.refundReason).toBe("timeout");
    expect(d.nodes.Revealed.state).toBe("unreachable");
    expect(d.nodes.Settled.state).toBe("unreachable");
    expect(d.nodes.Refunded.evidence?.txHash).toBe(txsOf("pur-freight-weekly").find((t) => t.eventName === "Refunded")!.txHash);
    expect(d.edges.filter((x) => x.taken).map((x) => `${x.from}>${x.to}`)).toEqual(["Created>Funded", "Funded>Refunded"]);
  });
  it("swap order: Refunded from Revealed with reason mismatch", () => {
    const d = deriveDiagram(e("esc-ev-swap"), null, txsOf("pur-ev-swap"));
    expect(d.refundOrigin).toBe("Revealed");
    expect(d.refundReason).toBe("mismatch");
    expect(d.nodes.Revealed.state).toBe("done");
    expect(d.edges.find((x) => x.from === "Revealed" && x.to === "Refunded")?.taken).toBe(true);
    expect(d.edges.find((x) => x.from === "Revealed" && x.to === "Settled")?.taken).toBe(false);
  });
  it("the chain read wins over the stored status and flags the disagreement", () => {
    const chain: EscrowChainState = { status: "Revealed", challengeEnd: "1792867260", revealedKey: fx.escrows[0]!.keyCommitment, balanceAtomic: "0", blockNumber: "1", blockTimestamp: "1792863700" };
    const d = deriveDiagram(e("esc-weather"), chain, txsOf("pur-weather-daily"));
    expect(d.current).toBe("Revealed");
    expect(d.source).toBe("chain");
    expect(d.disagree).toBe(true);
    expect(d.nodes.Revealed.state).toBe("current");
    expect(d.nodes.Revealed.evidence).toBeUndefined(); // no KeyRevealed log indexed yet
  });
  it("the refund reason falls back to the Refunded log's decoded arg", () => {
    const stored = { ...e("esc-freight"), refundReason: undefined };
    const d = deriveDiagram(stored, null, txsOf("pur-freight-weekly"));
    expect(d.refundReason).toBe("timeout");
    expect(txArg(txsOf("pur-ev-swap").find((t) => t.eventName === "CheatProven"), "index")).toBe("3");
  });
  it("nodeEvidence takes the first confirmed log per state in chain order", () => {
    const ev = nodeEvidence(txsOf("pur-merged-national"));
    expect(Object.keys(ev).sort()).toEqual(["Created", "Funded", "Revealed", "Settled"]);
  });
});

describe("gateActions mirrors OverflowEscrow", () => {
  const base = { revealDeadline: 1_000n, challengeEnd: 2_000n, balance: 13_000_000n, complaintReady: false };
  it("Revealed: accept always; finalizePayout only after challengeEnd; complain only before it and with proofs", () => {
    const before = gateActions({ ...base, status: "Revealed", now: 1_500n });
    expect(before.accept.allowed).toBe(true);
    expect(before.finalizePayout).toMatchObject({ allowed: false, availableAt: "2000" });
    expect(before.finalizePayout.reason.startsWith("ChallengeOpen()")).toBe(true);
    expect(before.complain.reason.startsWith("BadProof()")).toBe(true);
    expect(gateActions({ ...base, status: "Revealed", now: 1_500n, complaintReady: true }).complain).toMatchObject({ allowed: true, until: "2000" });
    const after = gateActions({ ...base, status: "Revealed", now: 2_000n, complaintReady: true });
    expect(after.finalizePayout.allowed).toBe(true);
    expect(after.complain.reason.startsWith("ChallengeClosed()")).toBe(true);
    expect(after.claimTimeoutRefund.reason).toBe("BadStatus(Revealed)");
    expect(after.asOf).toBe("2000");
  });
  it("Created and Funded: claimTimeoutRefund only once the reveal deadline passed", () => {
    for (const status of ["Created", "Funded"] as const) {
      expect(gateActions({ ...base, status, now: 999n }).claimTimeoutRefund).toMatchObject({ allowed: false, availableAt: "1000" });
      expect(gateActions({ ...base, status, now: 1_000n }).claimTimeoutRefund.allowed).toBe(true);
      expect(gateActions({ ...base, status, now: 1_000n }).accept.reason).toBe(`BadStatus(${status})`);
    }
  });
  it("terminal states: only sweep, and only with a balance", () => {
    for (const status of ["Settled", "Refunded"] as const) {
      expect(gateActions({ ...base, status, now: 5_000n, balance: 0n }).sweep.reason.startsWith("NothingToSweep()")).toBe(true);
      expect(gateActions({ ...base, status, now: 5_000n, balance: 5n }).sweep.allowed).toBe(true);
      const g = gateActions({ ...base, status, now: 5_000n });
      expect([g.accept, g.finalizePayout, g.claimTimeoutRefund, g.complain].every((x) => !x.allowed)).toBe(true);
    }
  });
});

describe("mergeGates", () => {
  const local = gateActions({ status: "Funded", revealDeadline: 1_000n, challengeEnd: 0n, balance: 1n, now: 1_000n, complaintReady: false });
  it("uses the local gates when the service sent none", () => {
    const m = mergeGates(local, null);
    expect(m.claimTimeoutRefund).toMatchObject({ allowed: true, decidedBy: "local", localAgrees: true });
  });
  it("lets the service's gate win and records the disagreement", () => {
    const api: EscrowActions = { ...local, claimTimeoutRefund: { allowed: false, reason: "RevealWindowOpen(): judged at an earlier block", who: "anyone" } };
    const m = mergeGates(local, api);
    expect(m.claimTimeoutRefund).toMatchObject({ allowed: false, decidedBy: "api", localAgrees: false });
    expect(m.accept.localAgrees).toBe(true);
  });
});

describe("deadlines and previews", () => {
  it("counts down to the reveal deadline and the challenge end, and says expired once passed", () => {
    const esc = { ...e("esc-national"), revealDeadline: "1000", challengeEnd: "2000" };
    const live = liveDeadlines(esc, null, 1_500);
    expect(live.map((d) => [d.key, d.passed, d.countdown])).toEqual([
      ["reveal", true, "expired"],
      ["challenge", false, "8m 20s"],
    ]);
    expect(liveDeadlines({ ...esc, challengeEnd: undefined }, null, 500).map((d) => d.key)).toEqual(["reveal"]);
    expect(liveDeadlines({ ...esc, challengeEnd: undefined }, { status: "Revealed", challengeEnd: "3000", revealedKey: esc.keyCommitment, balanceAtomic: "0", blockNumber: "1", blockTimestamp: "1" }, 500)[1]?.at).toBe(3000n);
  });
  it("accept pays price + bond to the seller; a refund returns the balance to the treasury", () => {
    const esc = e("esc-national");
    const accept = actionPreview("accept", esc, fx.TREASURY_ADDRESS);
    expect(accept.amountAtomic).toBe(13_000_000n);
    expect(accept.destination.address).toBe(esc.sellerAddress);
    const refund = actionPreview("claimTimeoutRefund", esc, fx.TREASURY_ADDRESS, 13_000_000n);
    expect(refund.destination.address).toBe(fx.TREASURY_ADDRESS);
    expect(refund.payer.address).toBe(esc.escrowAddress);
    expect(actionPreview("sweep", esc, fx.TREASURY_ADDRESS, 7n).amountAtomic).toBe(7n);
  });
});
