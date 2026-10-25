import type { Address, Hex } from "viem";
import { assertTransition, explorerUrl, type PaymentPath, type PaymentStatus, type PurchaseOrder, type PurchaseStatus } from "@overflow/schemas";
import { randomNonce } from "../authorization";
import { authorizationDigest, signAuthorization, type Authorization, type TypedDataSigner } from "../typed-data";
import type { PurchaseStore } from "./store";
import {
  AlreadySubmittedError,
  AuthorizationInFlightError,
  PurchaseNotFoundError,
  QuoteMismatchError,
  quoteMismatches,
  type AdapterChainReader,
  type PaymentAdapter,
  type PaymentRequirements,
  type PaymentSubmission,
  type PreparedPayment,
} from "./types";
import { fetchPaymentRequirements } from "./x402";

export interface AdapterDeps {
  store: PurchaseStore;
  /** The paying node's key. Resolved per purchase; the adapter never sees raw key material. */
  signerForNode(nodeId: number): Promise<TypedDataSigner>;
  chain: AdapterChainReader;
  fetch: typeof fetch;
  /** Overflow facilitator base URL (POST /settle, /reserve, /release). */
  serviceUrl: string;
  now?: () => Date;
  /** Abort an HTTP call after this long. A timeout after a submit is PAYMENT_UNKNOWN, never a retry. */
  requestTimeoutMs?: number;
  /** Default quote lifetime when the seller gives no maxTimeoutSeconds. */
  defaultValiditySec?: number;
}

export type HttpResult = { kind: "response"; status: number; json: Record<string, unknown> } | { kind: "unreachable"; error: string };

/** Submitted or later: a second submit is never allowed; reconcile instead. */
const IN_FLIGHT_OR_DONE: readonly PurchaseStatus[] = ["PAYMENT_PENDING", "PAYMENT_UNKNOWN", "ESCROW_FUNDED", "DELIVERY_PENDING", "SETTLED", "REFUNDED"];

export abstract class BaseAdapter implements PaymentAdapter {
  abstract readonly path: PaymentPath;
  protected readonly now: () => Date;
  protected readonly timeoutMs: number;
  protected readonly defaultValiditySec: number;

  constructor(protected readonly deps: AdapterDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timeoutMs = deps.requestTimeoutMs ?? 60_000;
    this.defaultValiditySec = deps.defaultValiditySec ?? 300;
  }

  abstract submitPayment(purchaseId: string): Promise<PaymentSubmission>;
  abstract reconcilePayment(purchaseId: string): Promise<PaymentStatus>;

  getPaymentRequirements(resourceUrl: string): Promise<PaymentRequirements> {
    return fetchPaymentRequirements(this.deps.fetch, resourceUrl);
  }

  /** How long this path lets an authorization live, in seconds from now. */
  protected abstract validityCapSec(): number;

  /**
   * Sign the one EIP-3009 authorization for this purchase: from = treasury, signed by the paying node key.
   * Refuses when a quote field differs from the order, and when an authorization already exists (any status).
   * Transition PROPOSED -> RESERVED.
   */
  async preparePayment(purchaseId: string, quote?: PaymentRequirements): Promise<PreparedPayment> {
    const order = await this.order(purchaseId);
    const existing = await this.deps.store.getPrepared(purchaseId);
    if (existing) throw new AuthorizationInFlightError(purchaseId, existing.digest, order.status);
    const requirements = quote ?? (await this.getPaymentRequirements(this.resourceUrlOf(order)));
    const mismatches = quoteMismatches(order, requirements);
    if (mismatches.length) throw new QuoteMismatchError(mismatches);
    assertTransition(order.status, "RESERVED");

    const nowSec = Math.floor(this.now().getTime() / 1000);
    const expiresSec = Math.floor(new Date(order.authorizationExpiresAt).getTime() / 1000);
    const validBefore = Math.min(nowSec + (requirements.maxTimeoutSeconds ?? this.defaultValiditySec), nowSec + this.validityCapSec(), expiresSec);
    if (validBefore <= nowSec) throw new Error(`purchase ${purchaseId}: authorizationExpiresAt already passed`);
    const authorization: Authorization = {
      from: order.buyerTreasury,
      to: requirements.payTo,
      value: order.amountAtomic,
      validAfter: String(nowSec - 60), // USDC needs block.timestamp > validAfter; allow a minute of clock skew
      validBefore: String(validBefore),
      nonce: randomNonce(),
    };
    const signer = await this.deps.signerForNode(order.payingNodeId);
    const signature = await signAuthorization(signer, authorization);
    const prepared: PreparedPayment = {
      purchaseId,
      path: this.path,
      requirements,
      authorization,
      signature,
      digest: authorizationDigest(authorization),
      createdAt: this.now().toISOString(),
    };
    await this.deps.store.savePrepared(prepared);
    await this.deps.store.setStatus(purchaseId, "RESERVED");
    return prepared;
  }

  // ------------------------------------------------------------------ shared helpers

  protected resourceUrlOf(order: PurchaseOrder): string {
    const url = (order as PurchaseOrder & { resourceUrl?: string }).resourceUrl;
    if (!url) throw new Error(`purchase ${order.id}: pass the seller's quote to preparePayment (no resourceUrl on the order)`);
    return url;
  }

  protected async order(purchaseId: string): Promise<PurchaseOrder> {
    const o = await this.deps.store.getOrder(purchaseId);
    if (!o) throw new PurchaseNotFoundError(purchaseId);
    return o;
  }

  /** The prepared authorization is looked up before anything else; without it there is nothing to retry. */
  protected async preparedOrThrow(purchaseId: string): Promise<PreparedPayment> {
    const p = await this.deps.store.getPrepared(purchaseId);
    if (!p) throw new Error(`purchase ${purchaseId} has no authorization; call preparePayment first`);
    return p;
  }

  /** Guard for submitPayment: exactly once, from RESERVED, then mark PAYMENT_PENDING before any network call. */
  protected async beginSubmit(purchaseId: string): Promise<{ order: PurchaseOrder; prepared: PreparedPayment }> {
    const order = await this.order(purchaseId);
    if (IN_FLIGHT_OR_DONE.includes(order.status)) throw new AlreadySubmittedError(purchaseId, order.status);
    const prepared = await this.preparedOrThrow(purchaseId);
    await this.transition(order, "PAYMENT_PENDING");
    return { order, prepared };
  }

  /** assertTransition from @overflow/schemas, then persist. A no-op when the status is unchanged. */
  protected async transition(order: PurchaseOrder, to: PurchaseStatus): Promise<PurchaseStatus> {
    if (order.status === to) return to;
    assertTransition(order.status, to);
    await this.deps.store.setStatus(order.id, to);
    order.status = to;
    return to;
  }

  protected async post(path: string, body: unknown): Promise<HttpResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.deps.fetch(`${this.deps.serviceUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { kind: "response", status: res.status, json };
    } catch (e) {
      return { kind: "unreachable", error: e instanceof Error ? (e.name === "AbortError" ? `timeout after ${this.timeoutMs} ms` : e.message) : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  protected async noteTx(purchaseId: string, tx: unknown): Promise<Hex | undefined> {
    if (typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx)) {
      await this.deps.store.addTxHash(purchaseId, tx as Hex);
      return tx as Hex;
    }
    return undefined;
  }

  protected decodedLabel(json: Record<string, unknown>): string | undefined {
    const d = json["decoded"] as { name?: string; args?: string[] } | undefined;
    return d?.name ? `${d.name}(${(d.args ?? []).join(",")})` : undefined;
  }

  protected status(
    order: PurchaseOrder,
    prepared: PreparedPayment | undefined,
    extra: Partial<Omit<PaymentStatus, "purchaseId" | "path" | "status" | "checkedAt">> = {},
  ): PaymentStatus {
    return {
      purchaseId: order.id,
      path: this.path,
      status: order.status,
      ...(prepared ? { authorizationDigest: prepared.digest, nonce: prepared.authorization.nonce } : {}),
      ...(extra.txHash ? { explorerUrl: explorerUrl("tx", extra.txHash) } : {}),
      ...extra,
      checkedAt: this.now().toISOString(),
    };
  }

  protected submission(order: PurchaseOrder, prepared: PreparedPayment, extra: Partial<PaymentSubmission> = {}): PaymentSubmission {
    return {
      purchaseId: order.id,
      path: this.path,
      status: order.status,
      digest: prepared.digest,
      ...(extra.txHash ? { explorerUrl: explorerUrl("tx", extra.txHash) } : {}),
      ...extra,
      submittedAt: this.now().toISOString(),
    };
  }

  protected treasury(order: PurchaseOrder): Address {
    return order.buyerTreasury;
  }

  protected expired(prepared: PreparedPayment): boolean {
    return Math.floor(this.now().getTime() / 1000) >= Number(prepared.authorization.validBefore);
  }
}
