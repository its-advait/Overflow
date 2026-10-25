import type { OrderOutcomeView, SellerBehaviour } from "@overflow/schemas";

// ---------------------------------------------------------------------------
// Copy for the "run one SIMULATED order" control: what the judge should expect
// the contracts to do for each behaviour, before the click (docs/SPEC.md "UI":
// payer, amount, destination and expected outcome shown before any money
// action). The outcome itself is only ever read back from the indexer.
// ---------------------------------------------------------------------------

export const BEHAVIOUR_LABEL: Record<SellerBehaviour, string> = { honest: "honest", ghost: "ghost", swap: "swap" };

export const BEHAVIOUR_HINT: Record<SellerBehaviour, string> = {
  honest: "commits truthfully, reveals the key on time, delivery verified, paid",
  ghost: "commits truthfully, never reveals; the buyer claims the timeout refund",
  swap: "swaps a chunk the sample misses; caught by complainMismatch, price and bond return to the treasury",
};

/** What the chain should confirm for an order run with this behaviour; the indexer's status is the only proof. */
export function expectedOutcome(behaviour: SellerBehaviour): string {
  switch (behaviour) {
    case "honest":
      return "settle() funds the escrow, the seller reveals, the root node accepts: PaidOut to the seller (SETTLED).";
    case "ghost":
      return "settle() funds the escrow, the seller never reveals, the clock passes the reveal window: claimTimeoutRefund returns price and bond to the treasury (REFUNDED).";
    case "swap":
      return "settle() funds the escrow, the seller reveals a swapped chunk: complainMismatch proves it, price and bond return to the treasury and the seller is flagged (REFUNDED).";
  }
}

/** The escrow page for an order the runner started. */
export function orderLink(order: Pick<OrderOutcomeView, "purchaseId">): string {
  return `/escrow/${encodeURIComponent(order.purchaseId)}`;
}

/** The runner's transaction labels in the order they happen. */
export const TX_ORDER = ["create", "bond", "settle", "markFunded", "revealKey", "accept", "complainMismatch", "claimTimeoutRefund"] as const;

export function orderedTxs(txs: OrderOutcomeView["txs"]): { label: string; hash: OrderOutcomeView["txs"][string] }[] {
  const known = TX_ORDER.filter((k) => k in txs).map((k) => ({ label: k, hash: txs[k]! }));
  const rest = Object.keys(txs)
    .filter((k) => !(TX_ORDER as readonly string[]).includes(k))
    .map((k) => ({ label: k, hash: txs[k]! }));
  return [...known, ...rest];
}
