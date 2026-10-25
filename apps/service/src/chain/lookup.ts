import type { Repositories } from "@overflow/database";
import { isTerminalStatus, type Address, type ChainTransaction, type EscrowOrder, type PurchaseRecord } from "@overflow/schemas";
import { getAddress, isAddress } from "viem";

// ---------------------------------------------------------------------------
// Shared chain-to-record lookups used by the event handlers and the ledger
// posting rules. Pure reads; nothing here writes. Escrow and factory events
// carry no orderId: the emitting address is the order, so most lookups key on
// the escrow address (compared case-insensitively; RPCs return lowercase).
// ---------------------------------------------------------------------------

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The spellings an address may have been stored under: as given, checksummed, lowercase. */
function addressForms(address: string): string[] {
  const forms = new Set<string>([address, address.toLowerCase()]);
  if (isAddress(address, { strict: false })) forms.add(getAddress(address));
  return [...forms];
}

/** Prefer the active purchase for an order; fall back to the newest terminal one. */
export async function purchaseForOrder(repos: Repositories, orderId: string): Promise<PurchaseRecord | undefined> {
  const list = await repos.purchases.listByOrderId(orderId);
  return list.find((p) => !isTerminalStatus(p.status)) ?? list.at(-1);
}

/** The stored factory OrderCreated log naming this escrow, if the indexer has seen it. */
export async function orderCreatedForEscrow(repos: Repositories, escrow: Address): Promise<ChainTransaction | undefined> {
  const rows = await repos.chainTransactions.listByEvent("OrderCreated");
  return rows.find((r) => typeof r.args["escrow"] === "string" && same(r.args["escrow"], escrow));
}

/** The escrow_orders row for an escrow address, whatever case it was stored in. */
export async function escrowForAddress(repos: Repositories, escrow: Address): Promise<EscrowOrder | undefined> {
  for (const form of addressForms(escrow)) {
    const found = await repos.escrowOrders.getByAddress(form);
    if (found) return found;
  }
  return undefined;
}

/** Purchases whose escrowAddress (or direct payTo) is this address, whatever case it was stored in. */
async function purchasesForPayee(repos: Repositories, payee: Address): Promise<PurchaseRecord[]> {
  const seen = new Map<string, PurchaseRecord>();
  for (const form of addressForms(payee)) for (const p of await repos.purchases.listByEscrowAddress(form)) seen.set(p.id, p);
  return [...seen.values()];
}

/** The purchase an escrow belongs to: its escrow_orders row first, then the active purchase naming the address, then the newest. */
export async function purchaseForEscrow(repos: Repositories, escrow: Address): Promise<PurchaseRecord | undefined> {
  const order = await escrowForAddress(repos, escrow);
  if (order) {
    const p = await repos.purchases.getById(order.purchaseId);
    if (p) return p;
  }
  const list = await purchasesForPayee(repos, escrow);
  return list.find((p) => !isTerminalStatus(p.status)) ?? list.at(-1);
}

/**
 * True when `address` is an escrow: the factory emitted OrderCreated for it or
 * an escrow_orders row names it. USDC moving between the treasury and such an
 * address is booked by the escrow's own events, never by the transfer.
 */
export async function isKnownEscrow(repos: Repositories, address: Address): Promise<boolean> {
  if (await escrowForAddress(repos, address)) return true;
  return (await orderCreatedForEscrow(repos, address)) !== undefined;
}

/** The purchase waiting on a payment to `payee` (its escrow or direct payTo address), if any. */
export async function waitingPurchaseForPayee(repos: Repositories, payee: Address): Promise<PurchaseRecord | undefined> {
  const candidates = await purchasesForPayee(repos, payee);
  return (
    candidates.find((p) => p.status === "PAYMENT_PENDING" || p.status === "PAYMENT_UNKNOWN" || p.status === "RESERVED") ??
    candidates.find((p) => !isTerminalStatus(p.status))
  );
}

/**
 * The order's price in atomic USDC: from its escrow_orders row, else from the factory's OrderCreated
 * (escrow events themselves carry no price; OrderFunded reports the balance, which includes the bond).
 */
export async function orderAmountForEscrow(repos: Repositories, escrow: Address): Promise<{ amount: bigint; bond: bigint } | undefined> {
  const order = await escrowForAddress(repos, escrow);
  if (order) return { amount: BigInt(order.amountAtomic), bond: BigInt(order.bondAtomic) };
  const created = await orderCreatedForEscrow(repos, escrow);
  if (created && typeof created.args["amount"] === "string") return { amount: BigInt(created.args["amount"]), bond: 0n };
  return undefined;
}
