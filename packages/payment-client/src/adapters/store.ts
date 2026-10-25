import type { PurchaseOrder, PurchaseStatus } from "@overflow/schemas";
import type { PreparedPayment } from "./types";

/**
 * What an adapter persists. Postgres implements this later (SPEC tables `purchases`, `chain_transactions`,
 * `reservations`); MemoryPurchaseStore serves tests and the demo. Status writes always go through
 * assertTransition in the adapter, never here.
 */
export interface PurchaseStore {
  getOrder(purchaseId: string): Promise<PurchaseOrder | undefined>;
  setStatus(purchaseId: string, status: PurchaseStatus): Promise<void>;
  /** The one prepared authorization for a purchase, if any. */
  getPrepared(purchaseId: string): Promise<PreparedPayment | undefined>;
  savePrepared(p: PreparedPayment): Promise<void>;
  /** Transaction hashes seen for this purchase (reserve, settle, release ...). Idempotent. */
  addTxHash(purchaseId: string, txHash: `0x${string}`): Promise<void>;
}

export class MemoryPurchaseStore implements PurchaseStore {
  private readonly orders = new Map<string, PurchaseOrder>();
  private readonly prepared = new Map<string, PreparedPayment>();

  constructor(orders: PurchaseOrder[] = []) {
    for (const o of orders) this.orders.set(o.id, structuredClone(o));
  }
  async getOrder(id: string) {
    const o = this.orders.get(id);
    return o ? structuredClone(o) : undefined;
  }
  async setStatus(id: string, status: PurchaseStatus) {
    const o = this.orders.get(id);
    if (!o) return;
    o.status = status;
  }
  async getPrepared(id: string) {
    const p = this.prepared.get(id);
    return p ? structuredClone(p) : undefined;
  }
  async savePrepared(p: PreparedPayment) {
    this.prepared.set(p.purchaseId, structuredClone(p));
    const o = this.orders.get(p.purchaseId);
    if (o) o.authorizationDigest = p.digest;
  }
  async addTxHash(id: string, txHash: `0x${string}`) {
    const o = this.orders.get(id);
    if (o && !o.txHashes.includes(txHash)) o.txHashes.push(txHash);
  }
}
