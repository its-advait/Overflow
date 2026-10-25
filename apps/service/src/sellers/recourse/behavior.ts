import type { SellerBehavior } from "./protocol.js";

// SIMULATED seller behavior switches (honest | swap | ghost), flipped at runtime
// over PUT /sellers/:id/behavior so the demo can show each recourse path.

export interface BehaviorChange {
  sellerId: string;
  at: string;
  from: SellerBehavior;
  to: SellerBehavior;
}

export interface BehaviorStore {
  get(sellerId: string): SellerBehavior | undefined;
  set(sellerId: string, behavior: SellerBehavior): BehaviorChange;
  list(): { sellerId: string; behavior: SellerBehavior }[];
  history(): readonly BehaviorChange[];
}

export function createBehaviorStore(initial: Map<string, SellerBehavior>, now: () => Date = () => new Date()): BehaviorStore {
  const current = new Map(initial);
  const changes: BehaviorChange[] = [];
  return {
    get: (sellerId) => current.get(sellerId),
    set(sellerId, behavior) {
      const from = current.get(sellerId) ?? "honest";
      current.set(sellerId, behavior);
      const change = { sellerId, at: now().toISOString(), from, to: behavior };
      changes.push(change);
      return change;
    },
    list: () => [...current.entries()].map(([sellerId, behavior]) => ({ sellerId, behavior })),
    history: () => changes,
  };
}
