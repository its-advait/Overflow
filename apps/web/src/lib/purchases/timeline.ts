import type { ActivityEvent, ChainTransaction, EscrowOrder, Hex, PurchaseRecord, PurchaseStatus } from "@overflow/schemas";

// ---------------------------------------------------------------------------
// PaymentTimeline view model (docs/SPEC.md "Purchase state machine"). Pure:
// no React, no fetching. A step is "done" only when the purchase's stored
// status has reached or passed it, and a tx hash appears only when a confirmed
// chain transaction or an activity event carries one. Nothing is inferred
// from the authorize response.
// ---------------------------------------------------------------------------

export type StepState = "done" | "current" | "pending" | "skipped";
/** Where the step's evidence came from: a decoded chain log, a service record (activity event), or nothing yet. */
export type StepSource = "chain" | "service" | "none";
export type TimelinePhase = "authorization" | "funding" | "settlement";

export interface TimelineStep {
  status: PurchaseStatus;
  phase: TimelinePhase;
  state: StepState;
  source: StepSource;
  at?: string;
  txHash?: Hex;
  blockNumber?: string;
  note?: string;
  decodedRevert?: string;
}

/** Keeps the three financial events apart: authorization, escrow funding, final settlement. */
export const PHASE_OF: Record<PurchaseStatus, TimelinePhase> = {
  PROPOSED: "authorization",
  RESERVED: "authorization",
  PAYMENT_PENDING: "authorization",
  REJECTED: "authorization",
  FAILED_BEFORE_FUNDING: "authorization",
  RELEASED: "authorization",
  PAYMENT_UNKNOWN: "funding",
  ESCROW_FUNDED: "funding",
  DELIVERY_PENDING: "funding",
  SETTLED: "settlement",
  REFUNDED: "settlement",
};

const HAPPY: readonly PurchaseStatus[] = ["PROPOSED", "RESERVED", "PAYMENT_PENDING", "ESCROW_FUNDED", "DELIVERY_PENDING"];
const TERMINAL_HAPPY: readonly PurchaseStatus[] = ["SETTLED", "REFUNDED"];
const SIDE_EXITS: readonly PurchaseStatus[] = ["REJECTED", "PAYMENT_UNKNOWN", "FAILED_BEFORE_FUNDING", "RELEASED"];

/** Chain event name -> the status the indexer sets from it (apps/service/src/chain/handlers.ts). */
const STATUS_BY_CHAIN_EVENT: Record<string, PurchaseStatus> = {
  Reserved: "RESERVED",
  OrderFunded: "ESCROW_FUNDED",
  KeyRevealed: "DELIVERY_PENDING",
  PaidOut: "SETTLED",
  Refunded: "REFUNDED",
  ReservationReleased: "RELEASED",
};

/** Activity kind -> status, for kinds that mean exactly one status. */
const STATUS_BY_KIND: Partial<Record<ActivityEvent["kind"], PurchaseStatus>> = {
  "purchase.proposed": "PROPOSED",
  "escrow.funded": "ESCROW_FUNDED",
  "escrow.revealed": "DELIVERY_PENDING",
  "escrow.settled": "SETTLED",
  "escrow.refunded": "REFUNDED",
  "policy.blocked": "REJECTED",
  "treasury.released": "RELEASED",
};

const TRANSITION = /^([A-Z_]+) -> ([A-Z_]+)/;

/** "FROM -> TO: reason" as the PurchaseService writes it; null when the message has no prefix. */
export function parseTransition(message: string): { from: PurchaseStatus; to: PurchaseStatus } | null {
  const m = TRANSITION.exec(message);
  if (!m) return null;
  const isStatus = (s: string): s is PurchaseStatus => s in PHASE_OF;
  return m[1] && m[2] && isStatus(m[1]) && isStatus(m[2]) ? { from: m[1], to: m[2] } : null;
}

function statusOfEvent(e: ActivityEvent): PurchaseStatus | undefined {
  const t = parseTransition(e.message);
  if (t) return t.to;
  if (e.kind === "payment.authorized") return "RESERVED";
  return STATUS_BY_KIND[e.kind];
}

export interface DeriveTimelineInput {
  purchase: PurchaseRecord;
  chainTransactions: readonly ChainTransaction[];
  activity: readonly ActivityEvent[];
  escrow?: EscrowOrder | null;
}

export function deriveTimeline({ purchase, chainTransactions, activity, escrow }: DeriveTimelineInput): TimelineStep[] {
  const status = purchase.status;
  const evidence = new Map<PurchaseStatus, Omit<TimelineStep, "status" | "phase" | "state">>();

  // Service records first (activity, oldest first), chain logs override them: the chain is the truth for funding and settlement.
  for (const e of [...activity].sort((a, b) => a.at.localeCompare(b.at))) {
    const s = statusOfEvent(e);
    if (!s || evidence.has(s)) continue;
    evidence.set(s, {
      source: "service",
      at: e.at,
      ...(e.txHash ? { txHash: e.txHash } : {}),
      ...(e.decodedRevert ? { decodedRevert: e.decodedRevert } : {}),
      note: e.message,
    });
  }
  const chainHashes = new Set<string>();
  for (const t of chainTransactions) {
    chainHashes.add(t.txHash.toLowerCase());
    if (!t.confirmed) continue;
    const s = STATUS_BY_CHAIN_EVENT[t.eventName];
    if (!s) continue;
    const prior = evidence.get(s);
    evidence.set(s, { ...prior, source: "chain", at: t.observedAt, txHash: t.txHash, blockNumber: t.blockNumber });
  }
  // The submission hash the authorize route appended, if the chain has not yet reported it as an event.
  const submitted = purchase.txHashes.find((h) => !chainHashes.has(h.toLowerCase()));
  if (submitted && !evidence.get("PAYMENT_PENDING")?.txHash) {
    evidence.set("PAYMENT_PENDING", { ...evidence.get("PAYMENT_PENDING"), source: evidence.get("PAYMENT_PENDING")?.source ?? "service", txHash: submitted });
  }
  if (!evidence.has("PROPOSED")) evidence.set("PROPOSED", { source: "service", at: purchase.createdAt });
  if (escrow?.refundReason && evidence.has("REFUNDED")) {
    const r = evidence.get("REFUNDED")!;
    evidence.set("REFUNDED", { ...r, note: escrow.refundReason });
  }

  const step = (s: PurchaseStatus, state: StepState): TimelineStep => {
    const ev = evidence.get(s);
    // Evidence is shown only for steps the status has actually reached.
    const shown = state === "done" || state === "current" ? ev : undefined;
    return {
      status: s,
      phase: PHASE_OF[s],
      state,
      source: shown?.source ?? "none",
      ...(shown?.at ? { at: shown.at } : state === "current" ? { at: purchase.updatedAt } : {}),
      ...(shown?.txHash ? { txHash: shown.txHash } : {}),
      ...(shown?.blockNumber ? { blockNumber: shown.blockNumber } : {}),
      ...(shown?.note ? { note: shown.note } : {}),
      ...(shown?.decodedRevert ? { decodedRevert: shown.decodedRevert } : {}),
    };
  };

  if (TERMINAL_HAPPY.includes(status)) {
    return [...HAPPY.map((s) => step(s, "done")), step(status, "done")];
  }
  if (SIDE_EXITS.includes(status)) {
    // Where did it leave the happy path? The transition event says; otherwise the furthest happy step with evidence.
    const exitEvent = activity.find((e) => parseTransition(e.message)?.to === status);
    const from = exitEvent ? parseTransition(exitEvent.message)!.from : undefined;
    const reached = from && HAPPY.includes(from) ? HAPPY.indexOf(from) : Math.max(0, ...HAPPY.map((s, i) => (evidence.has(s) ? i : -1)));
    const steps = HAPPY.map((s, i) => step(s, i <= reached ? "done" : "skipped"));
    const exit = step(status, "current");
    // Insert the exit right after the last reached step so the order reads chronologically.
    steps.splice(reached + 1, 0, exit);
    return steps;
  }
  // On the happy path, not yet final.
  const idx = HAPPY.indexOf(status);
  return [
    ...HAPPY.map((s, i) => step(s, i < idx ? "done" : i === idx ? "current" : "pending")),
    { status: "SETTLED", phase: "settlement", state: "pending", source: "none", note: "or REFUNDED if the seller fails to deliver" },
  ];
}
