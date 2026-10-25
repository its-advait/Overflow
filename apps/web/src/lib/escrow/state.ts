import type { ActionGate, ChainTransaction, EscrowAction, EscrowActions, EscrowChainState, EscrowOrder, EscrowStatus, Hex } from "@overflow/schemas";
import { expiryCountdown } from "@/lib/tree";

// ---------------------------------------------------------------------------
// Escrow detail view model (docs/SPEC.md "Recourse"). Pure: no React, no
// fetching. The state diagram lights the status the chain reports (the stored
// status when the service has no chain reader) and attaches to every node the
// confirmed log that proves it. The gates mirror the checks in
// contracts/src/OverflowEscrow.sol and are judged against the chain's clock;
// the service's gates win when present. Nothing here sends anything.
// ---------------------------------------------------------------------------

export const ESCROW_STATES: readonly EscrowStatus[] = ["Created", "Funded", "Revealed", "Settled", "Refunded"];
export const HAPPY_PATH: readonly EscrowStatus[] = ["Created", "Funded", "Revealed", "Settled"];

/** The escrow or factory event whose first confirmed log proves a node was reached (apps/service/src/chain/handlers.ts). */
export const EVENT_FOR_STATUS: Record<EscrowStatus, string> = {
  Created: "OrderCreated",
  Funded: "OrderFunded",
  Revealed: "KeyRevealed",
  Settled: "PaidOut",
  Refunded: "Refunded",
};

export interface NodeEvidence {
  txHash: Hex;
  blockNumber: string;
  observedAt: string;
}

const byChainOrder = (a: ChainTransaction, b: ChainTransaction): number => {
  const d = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  return d === 0n ? a.logIndex - b.logIndex : d < 0n ? -1 : 1;
};

/** Confirmed logs for this order, oldest first. */
export function confirmedLogs(txs: readonly ChainTransaction[]): ChainTransaction[] {
  return txs.filter((t) => t.confirmed).sort(byChainOrder);
}

/** The first confirmed log named `eventName`. */
export function findEvent(txs: readonly ChainTransaction[], eventName: string): ChainTransaction | undefined {
  return confirmedLogs(txs).find((t) => t.eventName === eventName);
}

/** One decoded argument as a string (args are stored as decoded JSON; bigints arrive as decimal strings). */
export function txArg(tx: ChainTransaction | undefined, name: string): string | undefined {
  const v = tx?.args[name];
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
}

/** The first confirmed log per escrow status. */
export function nodeEvidence(txs: readonly ChainTransaction[]): Partial<Record<EscrowStatus, NodeEvidence>> {
  const out: Partial<Record<EscrowStatus, NodeEvidence>> = {};
  for (const status of ESCROW_STATES) {
    const t = findEvent(txs, EVENT_FOR_STATUS[status]);
    if (t) out[status] = { txHash: t.txHash, blockNumber: t.blockNumber, observedAt: t.observedAt };
  }
  return out;
}

export type StatusSource = "chain" | "stored";

/** The chain's status wins; `disagree` flags a stored status the indexer has not caught up with (or vice versa). */
export function currentStatus(escrow: EscrowOrder, chain: EscrowChainState | null | undefined): { status: EscrowStatus; source: StatusSource; disagree: boolean } {
  if (!chain) return { status: escrow.status, source: "stored", disagree: false };
  return { status: chain.status, source: "chain", disagree: chain.status !== escrow.status };
}

export type NodeState = "done" | "current" | "pending" | "unreachable";

export interface DiagramNode {
  status: EscrowStatus;
  state: NodeState;
  evidence?: NodeEvidence;
}

export interface DiagramEdge {
  from: EscrowStatus;
  to: EscrowStatus;
  taken: boolean;
}

export interface Diagram {
  current: EscrowStatus;
  source: StatusSource;
  disagree: boolean;
  nodes: Record<EscrowStatus, DiagramNode>;
  /** The six legal transitions, in contract order; `taken` marks the path this order followed. */
  edges: DiagramEdge[];
  /** For a refunded order: the last happy-path state it reached before the refund. */
  refundOrigin?: EscrowStatus;
  refundReason?: string;
}

export const REFUND_REASON_TEXT: Record<string, string> = {
  timeout: "The seller never revealed the key before the reveal deadline; claimTimeoutRefund() returned the whole balance (price + bond) to the treasury.",
  mismatch: "A chunk did not decrypt to its committed plain leaf; complainMismatch() proved it onchain and the whole balance (price + bond) returned to the treasury.",
  promise: "A record broke the seller's signed source promise; complainPromise() proved it onchain and the whole balance (price + bond) returned to the treasury.",
};

export function refundReasonText(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return REFUND_REASON_TEXT[reason] ?? reason;
}

const rank = (s: EscrowStatus): number => HAPPY_PATH.indexOf(s);

export function deriveDiagram(escrow: EscrowOrder, chain: EscrowChainState | null | undefined, txs: readonly ChainTransaction[]): Diagram {
  const { status: current, source, disagree } = currentStatus(escrow, chain);
  const evidence = nodeEvidence(txs);
  const nodes = {} as Record<EscrowStatus, DiagramNode>;
  const edgeDefs: [EscrowStatus, EscrowStatus][] = [
    ["Created", "Funded"],
    ["Funded", "Revealed"],
    ["Revealed", "Settled"],
    ["Created", "Refunded"],
    ["Funded", "Refunded"],
    ["Revealed", "Refunded"],
  ];
  let refundOrigin: EscrowStatus | undefined;
  if (current === "Refunded") {
    // The last happy-path node a confirmed log proves; Created needs no log (the order exists).
    refundOrigin = evidence.Revealed ? "Revealed" : evidence.Funded ? "Funded" : escrow.challengeEnd ? "Revealed" : "Created";
    for (const s of HAPPY_PATH) {
      const state: NodeState = s === "Settled" ? "unreachable" : rank(s) <= rank(refundOrigin) ? "done" : "unreachable";
      nodes[s] = { status: s, state, ...(evidence[s] ? { evidence: evidence[s] } : {}) };
    }
    nodes.Refunded = { status: "Refunded", state: "current", ...(evidence.Refunded ? { evidence: evidence.Refunded } : {}) };
  } else {
    for (const s of HAPPY_PATH) {
      const state: NodeState = rank(s) < rank(current) ? "done" : rank(s) === rank(current) ? "current" : "pending";
      nodes[s] = { status: s, state, ...(evidence[s] ? { evidence: evidence[s] } : {}) };
    }
    nodes.Refunded = { status: "Refunded", state: current === "Settled" ? "unreachable" : "pending" };
  }
  const edges: DiagramEdge[] = edgeDefs.map(([from, to]) => {
    let taken: boolean;
    if (to === "Refunded") taken = current === "Refunded" && refundOrigin === from;
    else if (current === "Refunded") taken = refundOrigin !== undefined && rank(to) <= rank(refundOrigin);
    else taken = rank(to) <= rank(current);
    return { from, to, taken };
  });
  const refundReason = escrow.refundReason ?? txArg(findEvent(txs, "Refunded"), "reason");
  return {
    current,
    source,
    disagree,
    nodes,
    edges,
    ...(refundOrigin ? { refundOrigin } : {}),
    ...(refundReason ? { refundReason } : {}),
  };
}

// Deadlines ------------------------------------------------------------------

export function revealDeadlineOf(escrow: EscrowOrder): bigint {
  return BigInt(escrow.revealDeadline);
}

/** challengeEnd from the chain read, else the indexed KeyRevealed; 0n until the key is revealed. */
export function challengeEndOf(escrow: EscrowOrder, chain: EscrowChainState | null | undefined): bigint {
  if (chain) return BigInt(chain.challengeEnd);
  return escrow.challengeEnd ? BigInt(escrow.challengeEnd) : 0n;
}

export interface Deadline {
  key: "reveal" | "challenge";
  label: string;
  /** Unix seconds. */
  at: bigint;
  countdown: string;
  passed: boolean;
  /** What the contract allows once it passes. */
  consequence: string;
}

/** The two clocks the contract judges against, with a countdown from `nowSeconds` (the client's clock). */
export function liveDeadlines(escrow: EscrowOrder, chain: EscrowChainState | null | undefined, nowSeconds: number): Deadline[] {
  const out: Deadline[] = [];
  const reveal = revealDeadlineOf(escrow);
  out.push({
    key: "reveal",
    label: "Reveal deadline",
    at: reveal,
    countdown: expiryCountdown(reveal, nowSeconds),
    passed: BigInt(Math.floor(nowSeconds)) >= reveal,
    consequence: "After it, anyone may call claimTimeoutRefund() on a Created or Funded order.",
  });
  const challenge = challengeEndOf(escrow, chain);
  if (challenge > 0n) {
    out.push({
      key: "challenge",
      label: "Challenge window ends",
      at: challenge,
      countdown: expiryCountdown(challenge, nowSeconds),
      passed: BigInt(Math.floor(nowSeconds)) >= challenge,
      consequence: `Reveal time + ${escrow.challengeWindow} s. Until then the buyer may complain; after it, anyone may finalizePayout().`,
    });
  }
  return out;
}

/** Unix seconds as a deterministic UTC string. */
export function formatUnix(seconds: bigint | string): string {
  const n = Number(BigInt(seconds));
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `${new Date(n * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// Action gates -----------------------------------------------------------------

/** The calls that can ever be accepted from each status, in the order the panel shows them. */
export const ACTIONS_FROM: Record<EscrowStatus, readonly EscrowAction[]> = {
  Created: ["claimTimeoutRefund"],
  Funded: ["claimTimeoutRefund"],
  Revealed: ["accept", "finalizePayout", "complain"],
  Settled: ["sweep"],
  Refunded: ["sweep"],
};

export const ACTION_LABEL: Record<EscrowAction, string> = {
  accept: "Accept delivery",
  finalizePayout: "Finalize payout",
  claimTimeoutRefund: "Claim timeout refund",
  complain: "Complain (mismatch / promise)",
  sweep: "Sweep late USDC",
};

export interface GateInputs {
  status: EscrowStatus;
  revealDeadline: bigint;
  challengeEnd: bigint;
  balance: bigint;
  /** The clock the gates are judged at (a block timestamp when the chain was read). */
  now: bigint;
  complaintReady: boolean;
}

const TERMINAL: readonly EscrowStatus[] = ["Settled", "Refunded"];
const s = (n: bigint): string => n.toString();
const gate = (allowed: boolean, reason: string, who: string, extra: Partial<Pick<ActionGate, "availableAt" | "until">> = {}): ActionGate => ({ allowed, reason, who, ...extra });

/**
 * Local mirror of the service's computeEscrowActions (apps/service/src/recourse/actions.ts), used when the
 * service returned no gates (mock, or no chain reader) and to cross-check the ones it did return. Every
 * refusal starts with the error the contract would raise.
 */
export function gateActions(i: GateInputs): EscrowActions {
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

export interface MergedGate extends ActionGate {
  /** "api" when the service judged it (at the chain's block timestamp), "local" when this page did. */
  decidedBy: "api" | "local";
  /** False when the page's own mirror of the contract disagrees with the service's gate. */
  localAgrees: boolean;
}

export type MergedGates = Record<EscrowAction, MergedGate>;

export const ESCROW_ACTION_KEYS: readonly EscrowAction[] = ["accept", "finalizePayout", "claimTimeoutRefund", "complain", "sweep"];

/** The service's gates when present, each cross-checked against the local mirror; otherwise the local gates. */
export function mergeGates(local: EscrowActions, api: EscrowActions | null | undefined): MergedGates {
  const out = {} as MergedGates;
  for (const a of ESCROW_ACTION_KEYS) {
    const l = local[a];
    const g = api?.[a];
    out[a] = g ? { ...g, decidedBy: "api", localAgrees: g.allowed === l.allowed } : { ...l, decidedBy: "local", localAgrees: true };
  }
  return out;
}

export interface ActionPreview {
  title: string;
  payer: { label: string; address: string };
  destination: { label: string; address: string };
  amountAtomic: bigint;
  expectedOutcome: string;
}

/** Payer, amount, destination and expected outcome for one escrow call (docs/SPEC.md "UI": shown before anything runs). */
export function actionPreview(action: EscrowAction, escrow: EscrowOrder, treasury: string, chainBalance?: bigint): ActionPreview {
  const whole = BigInt(escrow.amountAtomic) + BigInt(escrow.bondAtomic);
  const payer = { label: "Escrow (holds price + bond)", address: escrow.escrowAddress };
  const seller = { label: "Seller", address: escrow.sellerAddress };
  const buyer = { label: "Buyer treasury", address: treasury };
  switch (action) {
    case "accept":
      return { title: ACTION_LABEL[action], payer, destination: seller, amountAtomic: whole, expectedOutcome: "Accepted(signer, nodeId) then PaidOut(seller, amount, bond): the escrow becomes Settled and the seller receives price + bond." };
    case "finalizePayout":
      return { title: ACTION_LABEL[action], payer, destination: seller, amountAtomic: whole, expectedOutcome: "PaidOut(seller, amount, bond) after a quiet challenge window: the escrow becomes Settled." };
    case "claimTimeoutRefund":
      return { title: ACTION_LABEL[action], payer, destination: buyer, amountAtomic: chainBalance ?? whole, expectedOutcome: 'Refunded("timeout"): the whole balance returns to the treasury; the seller forfeits the bond.' };
    case "complain":
      return { title: ACTION_LABEL[action], payer, destination: buyer, amountAtomic: chainBalance ?? whole, expectedOutcome: 'CheatProven(seller, index), CheatRecorded on the factory, then Refunded("mismatch" | "promise"): the whole balance returns to the treasury.' };
    case "sweep":
      return { title: ACTION_LABEL[action], payer: { label: "Closed escrow", address: escrow.escrowAddress }, destination: buyer, amountAtomic: chainBalance ?? 0n, expectedOutcome: "Swept(buyer, amount): USDC that reached the closed escrow late returns to the treasury." };
  }
}
