import { overflowEscrowAbi, overflowEscrowFactoryAbi, overflowTreasuryAbi } from "@overflow/schemas";
import { parseAbi, toEventSelector, type AbiEvent } from "viem";

// ---------------------------------------------------------------------------
// The indexer decodes against the ABIs generated from the built contracts
// (packages/schemas/src/abi, `pnpm contracts:export --abi-only`): treasury,
// factory and escrow events, errors and functions exactly as deployed. The
// snapshot in abi.test.ts pins every signature so a contract change shows up
// in review. Escrow and factory events carry no orderId: the emitting address
// is the order (SPEC "The escrow address is the order").
// ---------------------------------------------------------------------------

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
  return names.map((name) => {
    const ev = found.find((e) => e.name === name);
    if (!ev) throw new Error(`generated ABI has no event ${name}; rerun pnpm contracts:export --abi-only`);
    return ev;
  });
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

/** One copy of the revert reason table lives in @overflow/schemas; the decoder keeps its old name. */
export { TREASURY_REVERT_REASONS as REVERT_REASONS } from "@overflow/schemas";
