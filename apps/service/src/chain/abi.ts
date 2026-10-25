import { overflowEscrowAbi, overflowEscrowFactoryAbi, overflowTreasuryAbi } from "@overflow/schemas";
import { parseAbi, toEventSelector, type AbiEvent } from "viem";

// ---------------------------------------------------------------------------
// The indexed ABIs are the REAL contract ABIs generated from contracts/src by
// scripts/export-deployment.ts into packages/schemas/src/abi. Nothing here is
// hand-written any more; the snapshot in abi.test.ts pins the event signatures
// so a contract change that moves a selector shows up in review.
//
// Escrow events carry no orderId: the emitting escrow address (the log's
// `address`, stored as chain_transactions.contractAddress) is the link to the
// purchase and the escrow_orders row.
// ---------------------------------------------------------------------------

/**
 * Full treasury ABI. Besides the events it is used to ENCODE calldata for the
 * ControllerRequests the controller approves in Coinbase Wallet (setAllow,
 * raiseCap, pause; the service never sends them) and to DECODE reverts.
 */
export const treasuryAbi = overflowTreasuryAbi;
export const escrowFactoryAbi = overflowEscrowFactoryAbi;
export const escrowAbi = overflowEscrowAbi;

/** USDC's ERC-20 Transfer. The indexer fetches only the transfers into or out of the treasury. */
export const usdcAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

export const TREASURY_EVENTS = [
  "NodeCreated",
  "Paid",
  "Reserved",
  "ReservationReleased",
  "ReservationWindowSet",
  "NodePaused",
  "NodeUnpaused",
  "CapRaised",
  "AllowSet",
  "EscrowFactorySet",
] as const;
export const FACTORY_EVENTS = ["OrderCreated", "CheatRecorded"] as const;
export const ESCROW_EVENTS = ["OrderFunded", "KeyRevealed", "Accepted", "PaidOut", "Refunded", "CheatProven", "Swept"] as const;
export const USDC_EVENTS = ["Transfer"] as const;

export type TreasuryEventName = (typeof TREASURY_EVENTS)[number];
export type FactoryEventName = (typeof FACTORY_EVENTS)[number];
export type EscrowEventName = (typeof ESCROW_EVENTS)[number];
export type UsdcEventName = (typeof USDC_EVENTS)[number];
export type IndexedEventName = TreasuryEventName | FactoryEventName | EscrowEventName | UsdcEventName;

export type ContractKind = "treasury" | "factory" | "escrow" | "usdc";

const events = (abi: readonly unknown[], names: readonly string[]): AbiEvent[] => {
  const found = abi.filter((item): item is AbiEvent => (item as { type: string }).type === "event");
  for (const name of names) {
    if (!found.some((e) => e.name === name)) throw new Error(`event ${name} is not in the generated ABI`);
  }
  // Keep the declared order so the snapshot test reads like the list above.
  return names.map((name) => found.find((e) => e.name === name)!);
};

export const treasuryEvents: readonly AbiEvent[] = events(treasuryAbi, TREASURY_EVENTS);
export const factoryEvents: readonly AbiEvent[] = events(escrowFactoryAbi, FACTORY_EVENTS);
export const escrowEvents: readonly AbiEvent[] = events(escrowAbi, ESCROW_EVENTS);
export const usdcEvents: readonly AbiEvent[] = events(usdcAbi, USDC_EVENTS);
export const usdcTransferEvent: AbiEvent = usdcEvents[0]!;
/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC: `0x${string}` = toEventSelector(usdcTransferEvent);

/** Human-readable signature, e.g. "Paid(uint256,address,uint256,bytes32)". */
export function eventSignature(ev: AbiEvent): string {
  return `${ev.name}(${ev.inputs.map((i) => i.type).join(",")})`;
}

/** topic0 -> { kind, event } for every indexed event. Selectors are distinct across the four ABIs. */
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

/** What the Blocked lane says for each treasury revert (docs/SPEC.md; contracts/src/IOverflowTreasury.sol). */
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
  EscrowAmountMismatch: "Payment does not match the escrow's price plus bond",
  EscrowClosed: "That escrow already settled or refunded; paying it would strand USDC",
  ReservationTooLong: "Reservation validity exceeds the treasury's window",
  ReservationActive: "That digest is already reserved",
  NoReservation: "No reservation exists for that digest",
  ReservationLive: "The reservation has not expired yet",
  NotEscrowReservation: "The reservation pays a direct payee, not a factory escrow",
  EscrowStillOpen: "The escrow has not settled or refunded yet",
  AuthorizationUsed: "USDC already executed that authorization",
};
