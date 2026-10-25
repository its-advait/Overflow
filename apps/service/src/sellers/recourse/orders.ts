import type { Address, Hex } from "@overflow/schemas";
import type { EscrowStatusName, TxOutcome } from "./chain.js";
import type { OrderTermsWire, SellerBehavior } from "./protocol.js";

// ---------------------------------------------------------------------------
// SIMULATED in-memory order store for the Recourse sellers. Lost on restart on
// purpose: the chain (factory + escrows) is the record; this only remembers the
// key and ciphertext the seller must serve until the reveal.
// ---------------------------------------------------------------------------

export type OrderActionKind = "bond" | "markFunded" | "revealKey" | "finalizePayout";

export interface OrderAction {
  kind: OrderActionKind;
  behavior: SellerBehavior;
  txHash?: Hex;
  status: TxOutcome["status"];
  error?: string;
  at: string;
}

export interface OrderRecord {
  orderId: Hex;
  listingId: string;
  sellerId: string;
  sellerAddress: Address;
  buyer: Address;
  missionId: string;
  salt: Hex;
  terms: OrderTermsWire;
  escrowAddress: Address;
  createTxHash: Hex;
  /** Secret until revealKey() lands; never returned by publicView. */
  k: Hex;
  cipherChunks: Uint8Array[];
  plainLeaves: Hex[];
  swapIndex: number | null;
  behaviorAtCreate: SellerBehavior;
  createdAt: string;
  actions: OrderAction[];
  lastStatus: EscrowStatusName | null;
  bondSent: boolean;
  /** One-time worker notes (a note is appended at most once per text). */
  notes: string[];
  closed: boolean;
}

export interface OrderStore {
  insert(order: OrderRecord): OrderRecord;
  get(orderId: string): OrderRecord | undefined;
  findOpen(missionId: string, listingId: string, buyer: Address): OrderRecord | undefined;
  listOpen(): OrderRecord[];
  listAll(): OrderRecord[];
  update(orderId: Hex, patch: Partial<OrderRecord>): OrderRecord;
  /** Appends `note` unless an identical note already exists; returns true when appended. */
  noteOnce(orderId: Hex, note: string): boolean;
  size(): number;
}

export function createOrderStore(): OrderStore {
  const orders = new Map<string, OrderRecord>();
  const key = (id: string) => id.toLowerCase();
  const must = (orderId: string): OrderRecord => {
    const o = orders.get(key(orderId));
    if (!o) throw new Error(`SIMULATED order store: unknown order ${orderId}`);
    return o;
  };
  return {
    insert(order) {
      if (orders.has(key(order.orderId))) throw new Error(`SIMULATED order store: order ${order.orderId} already exists`);
      orders.set(key(order.orderId), order);
      return order;
    },
    get: (orderId) => orders.get(key(orderId)),
    findOpen(missionId, listingId, buyer) {
      for (const o of orders.values()) {
        if (!o.closed && o.missionId === missionId && o.listingId === listingId && o.buyer.toLowerCase() === buyer.toLowerCase()) return o;
      }
      return undefined;
    },
    listOpen: () => [...orders.values()].filter((o) => !o.closed),
    listAll: () => [...orders.values()],
    update(orderId, patch) {
      const o = must(orderId);
      Object.assign(o, patch);
      return o;
    },
    noteOnce(orderId, note) {
      const o = must(orderId);
      if (o.notes.includes(note)) return false;
      o.notes.push(note);
      return true;
    },
    size: () => orders.size,
  };
}

/** JSON-safe summary WITHOUT the key or ciphertext (k must never leak before the on-chain reveal). */
export function publicView(order: OrderRecord) {
  return {
    simulated: true as const,
    orderId: order.orderId,
    listingId: order.listingId,
    resourceId: order.listingId,
    sellerId: order.sellerId,
    sellerAddress: order.sellerAddress,
    buyer: order.buyer,
    missionId: order.missionId,
    salt: order.salt,
    terms: order.terms,
    escrowAddress: order.escrowAddress,
    createTxHash: order.createTxHash,
    chunkCount: order.terms.chunkCount,
    behaviorAtCreate: order.behaviorAtCreate,
    createdAt: order.createdAt,
    lastStatus: order.lastStatus,
    bondSent: order.bondSent,
    closed: order.closed,
    actions: order.actions,
    notes: order.notes,
  };
}
