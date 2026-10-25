import type { ActionGate, EscrowActions, EscrowStatus } from "@overflow/schemas";

// ---------------------------------------------------------------------------
// Which escrow calls the contract would accept right now, judged against the
// chain's clock (a block timestamp), never the wall clock. Mirrors the checks
// in contracts/src/OverflowEscrow.sol in their order; every refusal names the
// error the contract would raise. Nothing here sends anything.
// ---------------------------------------------------------------------------

export interface ActionInputs {
  status: EscrowStatus;
  /** OrderTerms.revealDeadline, unix seconds. */
  revealDeadline: bigint;
  /** challengeEnd(), unix seconds; 0 until the reveal. */
  challengeEnd: bigint;
  /** USDC held by the escrow. */
  balance: bigint;
  /** The block timestamp the gates are judged at. */
  now: bigint;
  /** True when a complaint with both Merkle proofs verified exists for this order (complainMismatch / complainPromise calldata). */
  complaintReady: boolean;
}

const TERMINAL: readonly EscrowStatus[] = ["Settled", "Refunded"];
const s = (n: bigint): string => n.toString();

const gate = (allowed: boolean, reason: string, who: string, extra: Partial<Pick<ActionGate, "availableAt" | "until">> = {}): ActionGate => ({
  allowed,
  reason,
  who,
  ...extra,
});

export function computeEscrowActions(i: ActionInputs): EscrowActions {
  const bad = (who: string): ActionGate => gate(false, `BadStatus(${i.status})`, who);

  const accept: ActionGate =
    i.status === "Revealed"
      ? gate(true, "accept(sig): Revealed; a treasury node key's EIP-712 Accept(orderId) signature pays the seller now (amount + bond)", "treasury node key")
      : bad("treasury node key");

  let finalizePayout: ActionGate;
  if (i.status !== "Revealed") finalizePayout = bad("anyone");
  else if (i.now < i.challengeEnd) finalizePayout = gate(false, `ChallengeOpen(): challenge window runs until ${s(i.challengeEnd)}`, "anyone", { availableAt: s(i.challengeEnd) });
  else finalizePayout = gate(true, "finalizePayout(): Revealed and the challenge window has closed with no proven complaint; pays the seller", "anyone");

  let claimTimeoutRefund: ActionGate;
  if (i.status !== "Created" && i.status !== "Funded") claimTimeoutRefund = bad("anyone");
  else if (i.now < i.revealDeadline) claimTimeoutRefund = gate(false, `RevealWindowOpen(): the seller may still reveal until ${s(i.revealDeadline)}`, "anyone", { availableAt: s(i.revealDeadline) });
  else claimTimeoutRefund = gate(true, `claimTimeoutRefund(): ${i.status} and the reveal deadline ${s(i.revealDeadline)} has passed; the whole balance returns to the treasury`, "anyone");

  let complain: ActionGate;
  if (i.status !== "Revealed") complain = bad("anyone");
  else if (i.now >= i.challengeEnd) complain = gate(false, `ChallengeClosed(): the challenge window ended at ${s(i.challengeEnd)}`, "anyone", { until: s(i.challengeEnd) });
  else if (!i.complaintReady) complain = gate(false, "BadProof(): no complaint with both Merkle proofs verified has been built for this order", "anyone", { until: s(i.challengeEnd) });
  else complain = gate(true, `complainMismatch/complainPromise(): Revealed, window open until ${s(i.challengeEnd)}, proofs verified; a proven cheat refunds price + bond`, "anyone", { until: s(i.challengeEnd) });

  let sweep: ActionGate;
  if (!TERMINAL.includes(i.status)) sweep = bad("anyone");
  else if (i.balance === 0n) sweep = gate(false, "NothingToSweep(): the closed escrow holds no USDC", "anyone");
  else sweep = gate(true, `sweep(): ${i.status} and ${s(i.balance)} atomic USDC arrived late; it returns to the treasury`, "anyone");

  return { accept, finalizePayout, claimTimeoutRefund, complain, sweep, asOf: s(i.now) };
}
