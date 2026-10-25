import type { Repositories } from "@overflow/database";
import { isTerminalStatus, type Address, type ChainTransaction, type PurchaseRecord } from "@overflow/schemas";

// ---------------------------------------------------------------------------
// Shared chain-to-record lookups used by the event handlers and the ledger
// posting rules. Pure reads; nothing here writes.
// ---------------------------------------------------------------------------

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Prefer the active purchase for an order; fall back to the newest terminal one. */
export async function purchaseForOrder(repos: Repositories, orderId: string): Promise<PurchaseRecord | undefined> {
  const list = await repos.purchases.listByOrderId(orderId);
  return list.find((p) => !isTerminalStatus(p.status)) ?? list.at(-1);
}

/** The stored factory OrderCreated log for an order, if the indexer has seen it. */
export async function orderCreatedFor(repos: Repositories, orderId: string): Promise<ChainTransaction | undefined> {
  const rows = await repos.chainTransactions.listByEvent("OrderCreated");
  return rows.find((r) => typeof r.args["orderId"] === "string" && same(r.args["orderId"], orderId));
}

/**
 * True when `address` is an escrow: the factory emitted OrderCreated for it or
 * an escrow_orders row names it. USDC moving between the treasury and such an
 * address is booked by the escrow's own events, never by the transfer.
 */
export async function isKnownEscrow(repos: Repositories, address: Address): Promise<boolean> {
  if (await repos.escrowOrders.getByAddress(address)) return true;
  const rows = await repos.chainTransactions.listByEvent("OrderCreated");
  return rows.some((r) => typeof r.args["escrow"] === "string" && same(r.args["escrow"], address));
}

/** The purchase waiting on a payment to `payee` (its escrow or direct payTo address), if any. */
export async function waitingPurchaseForPayee(repos: Repositories, payee: Address): Promise<PurchaseRecord | undefined> {
  const candidates = await repos.purchases.listByEscrowAddress(payee);
  return (
    candidates.find((p) => p.status === "PAYMENT_PENDING" || p.status === "PAYMENT_UNKNOWN" || p.status === "RESERVED") ??
    candidates.find((p) => !isTerminalStatus(p.status))
  );
}
