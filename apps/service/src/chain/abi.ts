import { parseAbi, toEventSelector, type AbiEvent } from "viem";

// ---------------------------------------------------------------------------
// PROVISIONAL ABI. No Overflow Solidity exists on this branch yet.
//
// The first six treasury events are copied from origin/person1
// contracts/src/IOverflowTreasury.sol. Every other event and error is derived
// from docs/SPEC.md ("Events", "reserve() and release()", "States and
// functions", "Errors and what the Blocked lane says"). Whoever writes the
// contracts must either emit exactly these signatures or edit this file; the
// snapshot in abi.test.ts makes any change visible in review.
// ---------------------------------------------------------------------------

export const treasuryAbi = parseAbi([
  // events (IOverflowTreasury.sol, person1)
  "event NodeCreated(uint256 indexed id, uint256 indexed parent, address key, uint256 cap, uint256 maxPerCall, uint256 expiry)",
  "event Paid(uint256 indexed id, address indexed to, uint256 value, bytes32 nonce)",
  "event NodePaused(uint256 indexed id, address by)",
  "event NodeUnpaused(uint256 indexed id)",
  "event CapRaised(uint256 indexed id, uint256 oldCap, uint256 newCap)",
  "event AllowSet(address indexed payee, bool allowed)",
  // events (new in Overflow; provisional)
  "event Reserved(bytes32 indexed digest, uint256 indexed id, address indexed to, uint256 value, uint256 validBefore, bytes32 nonce)",
  "event ReservationReleased(bytes32 indexed digest, uint256 indexed id, uint256 value, bool budgetRestored)",
  "event EscrowFactorySet(address indexed factory)",
  // errors (SPEC "Errors and what the Blocked lane says")
  "error UnknownAgent(address signer)",
  "error PayeeNotAllowed(uint256 node)",
  "error OverPerCall(uint256 node)",
  "error OverBudget(uint256 node)",
  "error Expired(uint256 node)",
  "error Paused(uint256 node)",
  "error BelowFloor()",
  "error TooDeep()",
  "error ChildExceedsParent()",
  "error BadDelegation()",
  "error KeyInUse()",
  "error NotAncestor()",
  "error NotOwner()",
  "error PayeeFlagged(address seller)",
  "error ReservationTooLong()",
  "error ReservationActive()",
]);

export const escrowFactoryAbi = parseAbi([
  "event OrderCreated(bytes32 indexed orderId, address indexed escrow, address indexed seller, address buyer, uint256 amount, uint256 bond, bytes32 termsHash)",
]);

export const escrowAbi = parseAbi([
  "event OrderFunded(bytes32 indexed orderId, uint256 amount)",
  "event KeyRevealed(bytes32 indexed orderId, bytes32 key)",
  "event Accepted(bytes32 indexed orderId, address signer)",
  "event PaidOut(bytes32 indexed orderId, address indexed seller, uint256 amount, uint256 bond)",
  "event Refunded(bytes32 indexed orderId, uint256 amount, string reason)",
  "event CheatProven(address indexed seller, uint256 index)",
  // Provisional: the seller's bond paid to the treasury on a missed reveal or a proven cheat
  // (SPEC "Bonds and cheater flags"). Refunded.amount is the price only; the bond is its own event.
  "event BondForfeited(bytes32 indexed orderId, address indexed seller, uint256 bond)",
]);

/** USDC's ERC-20 Transfer. The indexer fetches only the transfers into or out of the treasury. */
export const usdcAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

export const TREASURY_EVENTS = [
  "NodeCreated",
  "Paid",
  "Reserved",
  "ReservationReleased",
  "NodePaused",
  "NodeUnpaused",
  "CapRaised",
  "AllowSet",
  "EscrowFactorySet",
] as const;
export const FACTORY_EVENTS = ["OrderCreated"] as const;
export const ESCROW_EVENTS = ["OrderFunded", "KeyRevealed", "Accepted", "PaidOut", "Refunded", "CheatProven", "BondForfeited"] as const;
export const USDC_EVENTS = ["Transfer"] as const;

export type TreasuryEventName = (typeof TREASURY_EVENTS)[number];
export type FactoryEventName = (typeof FACTORY_EVENTS)[number];
export type EscrowEventName = (typeof ESCROW_EVENTS)[number];
export type UsdcEventName = (typeof USDC_EVENTS)[number];
export type IndexedEventName = TreasuryEventName | FactoryEventName | EscrowEventName | UsdcEventName;

export type ContractKind = "treasury" | "factory" | "escrow" | "usdc";

const events = (abi: readonly unknown[]): AbiEvent[] =>
  abi.filter((item): item is AbiEvent => (item as { type: string }).type === "event");

export const treasuryEvents: readonly AbiEvent[] = events(treasuryAbi);
export const factoryEvents: readonly AbiEvent[] = events(escrowFactoryAbi);
export const escrowEvents: readonly AbiEvent[] = events(escrowAbi);
export const usdcEvents: readonly AbiEvent[] = events(usdcAbi);
export const usdcTransferEvent: AbiEvent = usdcEvents[0]!;
/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC: `0x${string}` = toEventSelector(usdcTransferEvent);

/** Human-readable signature, e.g. "Paid(uint256,address,uint256,bytes32)". */
export function eventSignature(ev: AbiEvent): string {
  return `${ev.name}(${ev.inputs.map((i) => i.type).join(",")})`;
}

/** topic0 -> { kind, event } for every indexed event. Selectors are distinct across the three ABIs. */
export const EVENT_BY_TOPIC: ReadonlyMap<`0x${string}`, { kind: ContractKind; event: AbiEvent }> = (() => {
  const m = new Map<`0x${string}`, { kind: ContractKind; event: AbiEvent }>();
  const add = (kind: ContractKind, list: readonly AbiEvent[]): void => {
    for (const event of list) {
      const topic = toEventSelector(event);
      if (m.has(topic)) throw new Error(`duplicate event selector ${topic} for ${eventSignature(event)}`);
      m.set(topic, { kind, event });
    }
  };
  add("treasury", treasuryEvents);
  add("factory", factoryEvents);
  add("escrow", escrowEvents);
  add("usdc", usdcEvents);
  return m;
})();

/** What the Blocked lane says for each treasury revert (docs/SPEC.md). */
export const REVERT_REASONS: Readonly<Record<string, string>> = {
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
