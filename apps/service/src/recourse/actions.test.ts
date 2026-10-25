import type { EscrowStatus } from "@overflow/schemas";
import { describe, expect, it } from "vitest";
import { computeEscrowActions, type ActionInputs } from "./actions.js";

const base: ActionInputs = { status: "Created", revealDeadline: 1_000n, challengeEnd: 0n, balance: 0n, now: 500n, complaintReady: false };
const allowed = (i: Partial<ActionInputs>) => {
  const a = computeEscrowActions({ ...base, ...i });
  return Object.fromEntries(Object.entries(a).filter(([k]) => k !== "asOf").map(([k, g]) => [k, (g as { allowed: boolean }).allowed]));
};

describe("escrow action gates mirror OverflowEscrow", () => {
  it("Created / Funded: only claimTimeoutRefund, and only once the reveal deadline passed", () => {
    for (const status of ["Created", "Funded"] as EscrowStatus[]) {
      expect(allowed({ status, now: 999n })).toEqual({ accept: false, finalizePayout: false, claimTimeoutRefund: false, complain: false, sweep: false });
      expect(computeEscrowActions({ ...base, status, now: 999n }).claimTimeoutRefund).toMatchObject({ reason: expect.stringMatching(/^RevealWindowOpen/), availableAt: "1000" });
      expect(allowed({ status, now: 1_000n })).toMatchObject({ claimTimeoutRefund: true });
      expect(computeEscrowActions({ ...base, status, now: 1_000n }).accept.reason).toBe(`BadStatus(${status})`);
    }
  });
  it("Revealed: accept always; complain only inside the window with a verified proof; finalize only after it", () => {
    const revealed = { status: "Revealed" as EscrowStatus, challengeEnd: 2_000n };
    expect(allowed({ ...revealed, now: 1_500n })).toEqual({ accept: true, finalizePayout: false, claimTimeoutRefund: false, complain: false, sweep: false });
    expect(computeEscrowActions({ ...base, ...revealed, now: 1_500n }).complain.reason).toMatch(/^BadProof/);
    expect(allowed({ ...revealed, now: 1_500n, complaintReady: true })).toMatchObject({ complain: true });
    expect(computeEscrowActions({ ...base, ...revealed, now: 1_500n }).finalizePayout).toMatchObject({ reason: expect.stringMatching(/^ChallengeOpen/), availableAt: "2000" });
    expect(allowed({ ...revealed, now: 2_000n, complaintReady: true })).toEqual({ accept: true, finalizePayout: true, claimTimeoutRefund: false, complain: false, sweep: false });
    expect(computeEscrowActions({ ...base, ...revealed, now: 2_000n }).complain).toMatchObject({ reason: expect.stringMatching(/^ChallengeClosed/), until: "2000" });
  });
  it("Settled / Refunded: nothing but sweep, and only with a balance", () => {
    for (const status of ["Settled", "Refunded"] as EscrowStatus[]) {
      expect(allowed({ status, now: 5_000n })).toEqual({ accept: false, finalizePayout: false, claimTimeoutRefund: false, complain: false, sweep: false });
      expect(computeEscrowActions({ ...base, status }).sweep.reason).toMatch(/^NothingToSweep/);
      expect(allowed({ status, balance: 1n })).toMatchObject({ sweep: true });
    }
  });
  it("asOf is the chain clock it was judged at", () => {
    expect(computeEscrowActions({ ...base, now: 123n }).asOf).toBe("123");
  });
});
