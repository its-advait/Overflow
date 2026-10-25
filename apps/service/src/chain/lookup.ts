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

/**
 * The purchase an escrow's own events belong to. Escrow events carry no
 * orderId, so the emitting address is the link. Prefer the active purchase;
 * fall back to the newest terminal one (a Swept after settlement).
 */
export async function purchaseForEscrow(repos: Repositories, escrow: Address): Promise<PurchaseRecord | undefined> {
  const list = await repos.purchases.listByEscrowAddress(escrow);
  return list.find((p) => !isTerminalStatus(p.status)) ?? list.at(-1);
}

/** The stored factory OrderCreated log for an escrow address, if the indexer has seen it. */
export async function orderCreatedForEscrow(repos: Repositories, escrow: Address): Promise<ChainTransaction | undefined> {
  const rows = await repos.chainTransactions.listByEvent("OrderCreated");
  return rows.find((r) => typeof r.args["escrow"] === "string" && same(r.args["escrow"], escrow));
}

/**
 * True when `address` is an escrow: the factory emitted OrderCreated for it or
 * an escrow_orders row names it. USDC moving between the treasury and such an
 * address is booked by the escrow's own events, never by the transfer.
 */
export async function isKnownEscrow(repos: Repositories, address: Address): Promise<boolean> {
  if (await repos.escrowOrders.getByAddress(address)) return true;
  return (await orderCreatedForEscrow(repos, address)) !== undefined;
}

/** The purchase waiting on a payment to `payee` (its escrow or direct payTo address), if any. */
export async function waitingPurchaseForPayee(repos: Repositories, payee: Address): Promise<PurchaseRecord | undefined> {
  const candidates = await repos.purchases.listByEscrowAddress(payee);
  return (
    candidates.find((p) => p.status === "PAYMENT_PENDING" || p.status === "PAYMENT_UNKNOWN" || p.status === "RESERVED") ??
    candidates.find((p) => !isTerminalStatus(p.status))
  );
}
