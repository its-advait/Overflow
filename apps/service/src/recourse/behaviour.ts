import { SellerBehaviourSchema, type Address, type SellerBehaviour } from "@overflow/schemas";
import { SIMULATED_SELLER_LABEL } from "./seller-sim.js";

// ---------------------------------------------------------------------------
// Which behaviour each SIMULATED seller account plays on its next order. A judge
// changes it live through PUT /api/settings/sellers/:address; the runner reads
// it when the order starts. In memory for the life of the process (the local
// Anvil run restarts from a fresh provision anyway), defaults by position in
// RECOURSE_SELLER_KEYS: honest, ghost, swap. Nothing here touches the chain: a
// seller flagged by the factory stays flagged whatever this store says.
// ---------------------------------------------------------------------------

export { SellerBehaviourSchema, type SellerBehaviour };

export const DEFAULT_BEHAVIOURS: readonly SellerBehaviour[] = ["honest", "ghost", "swap"];

export interface SellerSetting {
  /** Position in RECOURSE_SELLER_KEYS. */
  index: number;
  address: Address;
  behaviour: SellerBehaviour;
  label: string;
}

export interface BehaviourStore {
  list(): SellerSetting[];
  /** Throws UnknownRecourseSellerError for an address that is not one of the SIMULATED sellers. */
  get(address: string): SellerBehaviour;
  set(address: string, behaviour: SellerBehaviour): SellerSetting;
  /** The seller's position, or undefined when the address is not a SIMULATED seller. */
  indexOf(address: string): number | undefined;
}

export class UnknownRecourseSellerError extends Error {
  constructor(public readonly address: string) {
    super(`${address} is not one of the SIMULATED recourse sellers`);
    this.name = "UnknownRecourseSellerError";
  }
}

export function createBehaviourStore(addresses: readonly Address[]): BehaviourStore {
  const byAddress = new Map<string, { index: number; address: Address; behaviour: SellerBehaviour }>();
  addresses.forEach((address, index) => {
    byAddress.set(address.toLowerCase(), { index, address, behaviour: DEFAULT_BEHAVIOURS[index % DEFAULT_BEHAVIOURS.length]! });
  });
  const view = (e: { index: number; address: Address; behaviour: SellerBehaviour }): SellerSetting => ({ ...e, label: SIMULATED_SELLER_LABEL[e.behaviour] });
  const lookup = (address: string) => {
    const e = byAddress.get(address.toLowerCase());
    if (!e) throw new UnknownRecourseSellerError(address);
    return e;
  };
  return {
    list: () => [...byAddress.values()].sort((a, b) => a.index - b.index).map(view),
    get: (address) => lookup(address).behaviour,
    set(address, behaviour) {
      const e = lookup(address);
      e.behaviour = SellerBehaviourSchema.parse(behaviour);
      return view(e);
    },
    indexOf: (address) => byAddress.get(address.toLowerCase())?.index,
  };
}
