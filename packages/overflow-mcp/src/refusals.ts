/**
 * Human text for the treasury's custom errors. Mirrors apps/service/src/facilitator/decode.ts (the facilitator
 * is the authority; these texts only label client-side prechecks and README tables).
 */
export const TREASURY_REASONS: Record<string, (args: readonly string[]) => string> = {
  UnknownAgent: ([s]) => `Signed by ${s ?? "?"}, which is not a registered agent key`,
  PayeeNotAllowed: ([n]) => (n === "0" ? "Recipient is not approved for anyone" : `Recipient is not approved for agent ${n ?? "?"}`),
  OverPerCall: ([n]) => `Single payment above agent ${n ?? "?"}'s per-call limit`,
  OverBudget: ([n]) => `Agent ${n ?? "?"} or an ancestor would pass its cap`,
  Expired: ([n]) => `Agent ${n ?? "?"}'s authority has expired`,
  Paused: ([n]) => `Agent ${n ?? "?"} is paused`,
  BelowFloor: () => "Payment would drop the treasury under its floor (reservations count)",
};

export function reasonFor(name: string, args: readonly string[]): string {
  const fn = TREASURY_REASONS[name];
  return fn ? fn(args) : `${name}(${args.join(", ")})`;
}

/** A decoded refusal: the treasury's revert (from /verify or the seller's 402) or a labeled client precheck. */
export interface Refusal {
  name: string;
  args: string[];
  /** Compact Solidity-style label, e.g. "PayeeNotAllowed(0)". */
  decoded: string;
  reason: string;
  /** Who produced it: "treasury (facilitator /verify, eth_call)", "treasury (seller settle)", "client-precheck (chain read)", ... */
  source: string;
}

export function refusal(name: string, args: readonly string[], source: string, reason = reasonFor(name, args)): Refusal {
  return { name, args: [...args], decoded: `${name}(${args.join(", ")})`, reason, source };
}
