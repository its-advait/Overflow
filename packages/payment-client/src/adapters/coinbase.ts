import type { PaymentStatus, PurchaseOrder } from "@overflow/schemas";
import { BaseAdapter, type AdapterDeps } from "./base";
import type { PaymentSubmission, PreparedPayment } from "./types";
import { b64encode, decodePaymentResponse, paymentPayload } from "./x402";

export interface CoinbaseAdapterDeps extends AdapterDeps {
  /** Treasury reservationWindow in seconds (default 600). validBefore must stay inside it. */
  reservationWindowSec?: number;
}

/**
 * Third-party x402 sellers: treasury.reserve() first (through the Overflow facilitator), then the standard x402
 * payload goes to the seller, whose middleware settles through Coinbase's facilitator; USDC asks the treasury
 * (ERC-1271) and gets a yes for the live reservation. reconcilePayment checks authorizationState and calls
 * /release after validBefore when the nonce was never used.
 */
export class CoinbaseFacilitatorAdapter extends BaseAdapter {
  readonly path = "coinbase-facilitator" as const;
  private readonly windowSec: number;

  constructor(deps: CoinbaseAdapterDeps) {
    super(deps);
    this.windowSec = deps.reservationWindowSec ?? 600;
  }

  protected validityCapSec(): number {
    return this.windowSec - 30; // leave a block or two under ReservationTooLong
  }

  async submitPayment(purchaseId: string): Promise<PaymentSubmission> {
    const { order, prepared } = await this.beginSubmit(purchaseId);

    // 1. reserve: every settle() check runs and the budget is charged; nothing moves yet
    const r = await this.post("/reserve", { paymentPayload: paymentPayload(prepared), paymentRequirements: prepared.requirements });
    if (r.kind === "unreachable") {
      await this.transition(order, "PAYMENT_UNKNOWN");
      return this.submission(order, prepared, { reason: `facilitator unreachable during reserve (${r.error}); reconcile` });
    }
    if (r.status === 409 || r.status >= 500) {
      await this.transition(order, "PAYMENT_UNKNOWN");
      return this.submission(order, prepared, { reason: r.status === 409 ? "reservation already submitted; reconcile" : `facilitator error ${r.status}` });
    }
    if (r.status !== 200) {
      await this.transition(order, "FAILED_BEFORE_FUNDING");
      return this.submission(order, prepared, { reason: `facilitator answered ${r.status}` });
    }
    const reserveTx = await this.noteTx(order.id, r.json["transaction"]);
    if (r.json["success"] !== true) {
      if (r.json["status"] === "unknown") {
        await this.transition(order, "PAYMENT_UNKNOWN");
        return this.submission(order, prepared, { ...(reserveTx ? { txHash: reserveTx } : {}), reason: String(r.json["errorReason"] ?? "no receipt for reserve") });
      }
      const decoded = this.decodedLabel(r.json);
      await this.transition(order, decoded ? "REJECTED" : "FAILED_BEFORE_FUNDING");
      return this.submission(order, prepared, { reason: String(r.json["errorReason"] ?? "reserve rejected"), ...(decoded ? { decodedRevert: decoded } : {}) });
    }

    // 2. the standard x402 request to the seller; its middleware settles through Coinbase's facilitator
    return this.paySeller(order, prepared, reserveTx);
  }

  private async paySeller(order: PurchaseOrder, prepared: PreparedPayment, reserveTx: `0x${string}` | undefined): Promise<PaymentSubmission> {
    const url = prepared.requirements.resource;
    if (!url) {
      return this.submission(order, prepared, { ...(reserveTx ? { txHash: reserveTx } : {}), reason: "reserved, but the quote carries no resource URL to pay" });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.deps.fetch(url, { method: "GET", headers: { "PAYMENT-SIGNATURE": b64encode(paymentPayload(prepared)) }, signal: ctrl.signal });
    } catch (e) {
      // The seller may have settled before the connection dropped: PAYMENT_UNKNOWN until the chain says.
      await this.transition(order, "PAYMENT_UNKNOWN");
      return this.submission(order, prepared, { ...(reserveTx ? { txHash: reserveTx } : {}), reason: `seller unreachable after reserve (${e instanceof Error ? e.message : String(e)}); reconcile` });
    } finally {
      clearTimeout(timer);
    }
    const pr = decodePaymentResponse(res.headers.get("payment-response"));
    if (res.ok && pr?.success) {
      const tx = await this.noteTx(order.id, pr.transaction);
      await this.transition(order, "ESCROW_FUNDED");
      return this.submission(order, prepared, { ...(tx ? { txHash: tx } : {}) });
    }
    if (res.ok) {
      await this.transition(order, "PAYMENT_UNKNOWN"); // served without a settlement proof: the chain decides
      return this.submission(order, prepared, { ...(reserveTx ? { txHash: reserveTx } : {}), reason: "seller served the resource without a PAYMENT-RESPONSE; reconcile" });
    }
    // Rejected by the seller or its facilitator. The reservation is live until validBefore, so stay pending;
    // reconcilePayment releases it after expiry if USDC never used the nonce.
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = String(pr?.errorReason ?? body["error"] ?? body["invalidReason"] ?? `seller answered ${res.status}`);
    return this.submission(order, prepared, { ...(reserveTx ? { txHash: reserveTx } : {}), reason: `seller/facilitator rejected the payment: ${reason}; reservation live until validBefore` });
  }

  /** The only retry path: digest and nonce first, then authorizationState, then release() after expiry. */
  async reconcilePayment(purchaseId: string): Promise<PaymentStatus> {
    const order = await this.order(purchaseId);
    const prepared = await this.deps.store.getPrepared(purchaseId);
    if (!prepared) return this.status(order, undefined, { reason: "no authorization was ever prepared" });
    if (!["RESERVED", "PAYMENT_PENDING", "PAYMENT_UNKNOWN"].includes(order.status)) return this.status(order, prepared);

    const used = await this.deps.chain.authorizationState(this.treasury(order), prepared.authorization.nonce);
    if (used) {
      // Paid is not emitted for reserved payments; USDC's nonce is the proof the money moved.
      await this.transition(order, "ESCROW_FUNDED");
      return this.status(order, prepared, { authorizationUsed: true, reason: "USDC consumed the reserved nonce" });
    }
    if (!this.expired(prepared)) {
      return this.status(order, prepared, { authorizationUsed: false, reason: "reservation live and unused; waiting for the seller's facilitator or validBefore" });
    }
    // Expired and unused: release restores the agent's allowance (the money never moved).
    const r = await this.post("/release", { digest: prepared.digest });
    if (r.kind === "unreachable") return this.status(order, prepared, { authorizationUsed: false, reason: `expired unused; release not sent (${r.error})` });
    const decoded = this.decodedLabel(r.json);
    if (r.status === 200 && r.json["ok"] === false && decoded === "ReservationLive()") {
      return this.status(order, prepared, { authorizationUsed: false, reason: "expired by our clock, not yet by the chain's; retry reconcile" });
    }
    const releaseTx = await this.noteTx(order.id, r.status === 409 ? (r.json["original"] as { txHash?: string } | undefined)?.txHash : r.json["transaction"]);
    // RESERVED (never handed to a seller) -> RELEASED; PAYMENT_PENDING/UNKNOWN -> FAILED_BEFORE_FUNDING.
    const to = order.status === "RESERVED" ? "RELEASED" : "FAILED_BEFORE_FUNDING";
    await this.transition(order, to);
    const refunded = r.json["refunded"];
    return this.status(order, prepared, {
      authorizationUsed: false,
      ...(releaseTx ? { txHash: releaseTx } : {}),
      reason: refunded === true ? "reservation released; allowance restored, no USDC moved" : decoded === "NoReservation()" ? "reservation already released by someone else; no USDC moved" : "reservation expired unused",
    });
  }
}
