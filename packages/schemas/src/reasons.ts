/**
 * What the Blocked lane and the agent panel say for each treasury revert
 * (docs/SPEC.md "Security core"). One copy, shared by the service's decoder and the web.
 */
export const TREASURY_REVERT_REASONS: Readonly<Record<string, string>> = {
  UnknownAgent: "Signed by a key that isn't a registered agent",
  PayeeNotAllowed: "Recipient isn't approved for this agent",
  OverPerCall: "Single payment above this agent's limit",
  OverBudget: "This agent or an ancestor would pass its cap",
  Expired: "This agent's authority expired",
  Paused: "This agent (or an ancestor) is paused",
  BelowFloor: "Payment would drop the treasury under its floor",
  TooDeep: "Delegation tree is too deep (max depth 2)",
  ChildExceedsParent: "Child limits exceed the parent's limits",
  BadDelegation: "Delegation is invalid, expired, replayed or signed by the wrong key",
  KeyInUse: "That key already belongs to a node (or is a reserved address)",
  NotAncestor: "Signer is not an ancestor of the target node",
  NotOwner: "Only the treasury owner can do that",
  PayeeFlagged: "Seller has a proven cheat on record",
  ReservationTooLong: "Reservation validity exceeds the treasury's window",
  ReservationActive: "That digest is already reserved",
};

/** "OverBudget(3)" -> { name: "OverBudget", args: ["3"], reason }. Unknown shapes keep the raw text as the name. */
export function parseDecodedRevert(decoded: string): { name: string; args: string[]; reason: string } {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/.exec(decoded.trim());
  const name = m?.[1] ?? decoded;
  const args = m && m[2] !== undefined && m[2].length > 0 ? m[2].split(",").map((s) => s.trim()) : [];
  return { name, args, reason: TREASURY_REVERT_REASONS[name] ?? decoded };
}
