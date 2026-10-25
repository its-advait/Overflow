import { parseDecodedRevert, TREASURY_REVERT_REASONS, type ActivityEvent } from "@overflow/schemas";
import { isBlocked } from "@/lib/overview/events";
import { bindingNodeOf } from "@/lib/tree";
import { digestOf, parseSourceRefs } from "./attribution";
import { byNewest } from "./filter";

/**
 * Refusal families the Blocked lane groups by. Treasury custom errors keep their own name; USDC's
 * Error(string) for a signature used outside settle() is the bypass; client-side refusals (the agent's
 * payment client would not sign) and the seller's payload check get their own family.
 */
export type RefusalFamily =
  | "PayeeNotAllowed"
  | "OverBudget"
  | "OverPerCall"
  | "Paused"
  | "Expired"
  | "UnknownAgent"
  | "BelowFloor"
  | "PayeeFlagged"
  | "Delegation"
  | "Reservation"
  | "QuoteMismatch"
  | "SigningRefused"
  | "InvalidPayment"
  | "USDC bypass"
  | "Other";

export const REFUSAL_FAMILY_ORDER: readonly RefusalFamily[] = [
  "PayeeNotAllowed",
  "USDC bypass",
  "OverBudget",
  "OverPerCall",
  "Paused",
  "Expired",
  "UnknownAgent",
  "BelowFloor",
  "PayeeFlagged",
  "QuoteMismatch",
  "SigningRefused",
  "InvalidPayment",
  "Delegation",
  "Reservation",
  "Other",
];

/** Where the refusal happened, so a judge can tell a simulated refusal from an onchain revert. */
export type RefusalStage = "refused before signing" | "refused in simulation" | "reverted onchain" | "rejected by USDC";

const DIRECT: Partial<Record<string, RefusalFamily>> = {
  PayeeNotAllowed: "PayeeNotAllowed",
  OverBudget: "OverBudget",
  OverPerCall: "OverPerCall",
  Paused: "Paused",
  Expired: "Expired",
  UnknownAgent: "UnknownAgent",
  BelowFloor: "BelowFloor",
  PayeeFlagged: "PayeeFlagged",
  TooDeep: "Delegation",
  ChildExceedsParent: "Delegation",
  BadDelegation: "Delegation",
  KeyInUse: "Delegation",
  NotAncestor: "Delegation",
  NotOwner: "Delegation",
  ReservationTooLong: "Reservation",
  ReservationActive: "Reservation",
  QuoteMismatchError: "QuoteMismatch",
  QuoteMismatch: "QuoteMismatch",
  SigningRefusedError: "SigningRefused",
  InvalidPayment: "InvalidPayment",
};

const USDC_SIGNATURE = /^FiatTokenV2: invalid signature/;

function isUsdcBypass(decodedRevert: string): boolean {
  const { name, args } = parseDecodedRevert(decodedRevert);
  return (name === "Error" && USDC_SIGNATURE.test(args.join(","))) || USDC_SIGNATURE.test(decodedRevert);
}

export function familyOf(decodedRevert: string | undefined): RefusalFamily {
  if (!decodedRevert) return "Other";
  if (isUsdcBypass(decodedRevert)) return "USDC bypass";
  return DIRECT[parseDecodedRevert(decodedRevert).name] ?? "Other";
}

/** The SPEC's Blocked-lane wording ("Errors and what the Blocked lane says"), plus the client-side refusals. */
export function humanReason(decodedRevert: string | undefined, fallback: string): string {
  if (!decodedRevert) return fallback;
  if (isUsdcBypass(decodedRevert)) return "USDC rejected the signature: it is only valid inside treasury.settle() or a live reservation";
  const { name, args } = parseDecodedRevert(decodedRevert);
  const n = args[0];
  switch (name) {
    case "PayeeNotAllowed":
      return n === "0" ? "Recipient isn't approved for anyone" : n ? `Recipient isn't approved for agent ${n}` : TREASURY_REVERT_REASONS["PayeeNotAllowed"]!;
    case "OverPerCall":
      return n ? `Single payment above agent ${n}'s limit` : TREASURY_REVERT_REASONS["OverPerCall"]!;
    case "OverBudget":
      return n ? `Agent ${n} or an ancestor would pass its cap` : TREASURY_REVERT_REASONS["OverBudget"]!;
    case "Expired":
      return n ? `Agent ${n}'s authority expired` : TREASURY_REVERT_REASONS["Expired"]!;
    case "Paused":
      return n ? `Agent ${n} (or an ancestor) is paused` : TREASURY_REVERT_REASONS["Paused"]!;
    case "QuoteMismatchError":
    case "QuoteMismatch":
      return "The seller's quote did not match the approved order, so the agent refused to sign";
    case "SigningRefusedError":
      return "The agent's payment client refused to sign this authorization";
    case "InvalidPayment":
      return "The signed payment did not match the seller's requirement; the facilitator was never asked";
    default:
      return TREASURY_REVERT_REASONS[name] ?? fallback;
  }
}

export interface RefusalEvidence {
  decoded: string;
  name: string;
  args: string[];
  family: RefusalFamily;
  reason: string;
  stage: RefusalStage;
  txHash?: `0x${string}`;
  digest?: `0x${string}`;
  /** The node the revert names as binding (OverBudget(3) -> 3), when it names one. */
  bindingNode: number | null;
  simulated: boolean;
}

export function refusalEvidence(e: ActivityEvent): RefusalEvidence {
  const decoded = e.decodedRevert ?? "unknown";
  const { name, args } = parseDecodedRevert(decoded);
  const family = familyOf(e.decodedRevert);
  const { flags } = parseSourceRefs(e.message);
  const stage: RefusalStage =
    family === "USDC bypass"
      ? "rejected by USDC"
      : family === "QuoteMismatch" || family === "SigningRefused"
        ? "refused before signing"
        : e.txHash || flags.includes("reverted onchain")
          ? "reverted onchain"
          : "refused in simulation";
  const digest = digestOf(e.message);
  return {
    decoded,
    name,
    args,
    family,
    reason: humanReason(e.decodedRevert, e.message),
    stage,
    ...(e.txHash ? { txHash: e.txHash as `0x${string}` } : {}),
    ...(digest ? { digest } : {}),
    bindingNode: bindingNodeOf(e.decodedRevert),
    simulated: e.simulated,
  };
}

/** Every refused payment, newest first. */
export function blockedEvents(events: readonly ActivityEvent[]): ActivityEvent[] {
  return events.filter(isBlocked).sort(byNewest);
}

export function countByFamily(events: readonly ActivityEvent[]): { family: RefusalFamily; count: number }[] {
  const counts = new Map<RefusalFamily, number>();
  for (const e of events) counts.set(familyOf(e.decodedRevert), (counts.get(familyOf(e.decodedRevert)) ?? 0) + 1);
  return REFUSAL_FAMILY_ORDER.filter((f) => counts.has(f)).map((family) => ({ family, count: counts.get(family)! }));
}
