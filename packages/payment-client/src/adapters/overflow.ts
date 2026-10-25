import type { PaymentStatus } from "@overflow/schemas";
import { BaseAdapter } from "./base";
import type { PaymentSubmission, PreparedPayment } from "./types";
import { paymentPayload } from "./x402";

/**
 * Overflow's own sellers and escrow funding: the Overflow facilitator relays treasury.settle() (transient gate).
 * submitPayment POSTs the one authorization to /settle; reconcilePayment reads the receipt and USDC's
 * authorizationState before anything else and never signs again.
 */
export class OverflowFacilitatorAdapter extends BaseAdapter {
  readonly path = "overflow-facilitator" as const;

  protected validityCapSec(): number {
    return 3600;
  }

  async submitPayment(purchaseId: string): Promise<PaymentSubmission> {
    const { order, prepared } = await this.beginSubmit(purchaseId);
    const r = await this.post("/settle", { paymentPayload: paymentPayload(prepared), paymentRequirements: prepared.requirements });
    if (r.kind === "unreachable") {
      // The request may have reached the relayer: the chain decides, in reconcilePayment.
      await this.transition(order, "PAYMENT_UNKNOWN");
      return this.submission(order, prepared, { reason: `facilitator unreachable after submit (${r.error}); reconcile, do not resign` });
    }
    return this.mapSettle(order, prepared, r.status, r.json);
  }

  private async mapSettle(order: Awaited<ReturnType<BaseAdapter["order"]>>, prepared: PreparedPayment, httpStatus: number, json: Record<string, unknown>): Promise<PaymentSubmission> {
    if (httpStatus === 409) {
      // Our digest was already submitted: use that result, never a new authorization.
      const original = json["original"] as { status?: string; txHash?: string; result?: Record<string, unknown> } | undefined;
      const txHash = await this.noteTx(order.id, original?.txHash);
      if (original?.status === "done" && original.result) return this.mapSettle(order, prepared, 200, original.result);
      await this.transition(order, "PAYMENT_UNKNOWN");
      return this.submission(order, prepared, { ...(txHash ? { txHash } : {}), reason: "already submitted and still pending at the facilitator" });
    }
    if (httpStatus >= 500) {
      await this.transition(order, "PAYMENT_UNKNOWN");
      return this.submission(order, prepared, { reason: `facilitator error ${httpStatus}; the relayer may have broadcast` });
    }
    if (httpStatus !== 200) {
      await this.transition(order, "FAILED_BEFORE_FUNDING");
      const err = json["error"] as { reason?: string } | undefined;
      return this.submission(order, prepared, { reason: err?.reason ?? `facilitator answered ${httpStatus}` });
    }
    const txHash = await this.noteTx(order.id, json["transaction"]);
    if (json["success"] === true) {
      await this.transition(order, "ESCROW_FUNDED");
      return this.submission(order, prepared, { ...(txHash ? { txHash } : {}) });
    }
    if (json["status"] === "unknown") {
      await this.transition(order, "PAYMENT_UNKNOWN");
      return this.submission(order, prepared, { ...(txHash ? { txHash } : {}), reason: String(json["errorReason"] ?? "no receipt") });
    }
    const decoded = this.decodedLabel(json);
    const reason = String(json["errorReason"] ?? "rejected");
    if (decoded) {
      await this.transition(order, "REJECTED"); // a policy revert, with its error
      return this.submission(order, prepared, { ...(txHash ? { txHash } : {}), reason, decodedRevert: decoded });
    }
    await this.transition(order, "FAILED_BEFORE_FUNDING");
    return this.submission(order, prepared, { reason });
  }

  /**
   * The only retry path. Looks up the original digest and nonce, then: receipt (if a hash is known), USDC's
   * authorizationState, and the authorization's expiry. Never broadcasts, never signs.
   */
  async reconcilePayment(purchaseId: string): Promise<PaymentStatus> {
    const order = await this.order(purchaseId);
    const prepared = await this.deps.store.getPrepared(purchaseId);
    if (!prepared) return this.status(order, undefined, { reason: "no authorization was ever prepared" });
    if (!["RESERVED", "PAYMENT_PENDING", "PAYMENT_UNKNOWN"].includes(order.status)) return this.status(order, prepared);

    const known = order.txHashes.at(-1);
    if (known) {
      const receipt = await this.deps.chain.getTransactionReceipt(known);
      if (receipt?.status === "success") {
        await this.transition(order, "ESCROW_FUNDED");
        return this.status(order, prepared, { txHash: known, authorizationUsed: true });
      }
      if (receipt?.status === "reverted") {
        // No USDC moved. A pending purchase records the policy revert; an unknown one may only fail forward.
        await this.transition(order, order.status === "PAYMENT_UNKNOWN" ? "FAILED_BEFORE_FUNDING" : "REJECTED");
        return this.status(order, prepared, { txHash: known, authorizationUsed: false, reason: "settle reverted onchain; no USDC moved" });
      }
    }
    const used = await this.deps.chain.authorizationState(this.treasury(order), prepared.authorization.nonce);
    if (used) {
      await this.transition(order, "ESCROW_FUNDED");
      const tx = await this.lookupTx(prepared);
      return this.status(order, prepared, { authorizationUsed: true, ...(tx ? { txHash: tx } : {}), reason: tx ? undefined : "USDC consumed the nonce; transaction hash not yet known" });
    }
    if (this.expired(prepared)) {
      await this.transition(order, "FAILED_BEFORE_FUNDING");
      return this.status(order, prepared, { authorizationUsed: false, reason: "authorization expired unused; no USDC moved" });
    }
    return this.status(order, prepared, { authorizationUsed: false, reason: "authorization still valid and unused; awaiting the facilitator" });
  }

  /** Ask the facilitator for its record of our digest. Idempotent: it answers 409 with the original result. */
  private async lookupTx(prepared: PreparedPayment): Promise<`0x${string}` | undefined> {
    const r = await this.post("/settle", { paymentPayload: paymentPayload(prepared), paymentRequirements: prepared.requirements });
    if (r.kind !== "response") return undefined;
    const original = r.json["original"] as { txHash?: string } | undefined;
    const tx = original?.txHash ?? r.json["transaction"];
    return typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx) ? (tx as `0x${string}`) : undefined;
  }
}
