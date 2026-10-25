import type { Address } from "viem";
import type { PurchaseOrder } from "@overflow/schemas";
import { signTransfer, type NodeSigner, type SignedTransferAuthorization } from "./authorization";
import { PaymentOutcomeUnknownError, PaymentRequiredParseError } from "./errors";
import { buildPaymentHeader, buildPaymentPayload, type PaymentHeader } from "./header";
import { checkQuote, selectRequirements, type CheckedQuote } from "./quote";
import type { TokenDomain } from "./token-domain";
import {
  parsePaymentRequired,
  parsePaymentResponse,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
} from "./x402";

// ---------------------------------------------------------------------------
// wrapFetch: a fetch that pays x402 402s with a treasury authorization signed by a node key.
// It signs only after checkQuote passes, sends the paid request exactly once, and reports the
// outcome through the adapter. It never moves USDC itself; the seller's facilitator (or the
// Overflow service's settle()) does, and the chain is the only source of truth.
// ---------------------------------------------------------------------------

export interface ResolveOrderContext {
  url: string;
  paymentRequired: PaymentRequired;
  requirements: PaymentRequirements;
}

export interface AuthorizedContext {
  order: PurchaseOrder;
  quote: CheckedQuote;
  signed: SignedTransferAuthorization;
  payload: PaymentPayload;
  header: PaymentHeader;
}

export interface PaymentResultContext {
  order: PurchaseOrder;
  signed: SignedTransferAuthorization;
  /** HTTP status of the paid response, or null when no response arrived. */
  status: number | null;
  /** Decoded PAYMENT-RESPONSE, or null when absent or when no response arrived. */
  settlement: SettlementResponse | null;
  /** Set when the paid request threw or its PAYMENT-RESPONSE header was malformed. */
  error?: unknown;
}

/**
 * How wrapFetch talks to the surrounding service (the PaymentAdapter of docs/SPEC.md owns the
 * purchase lifecycle; this is the slice of it the fetch wrapper needs).
 */
export interface PaymentFetchAdapter {
  /** The PurchaseOrder this 402 is paying for, or null to return the 402 unpaid. */
  resolveOrder(ctx: ResolveOrderContext): Promise<PurchaseOrder | null>;
  /** Owner-allowlisted sellers that may be paid directly instead of through an escrow. */
  approvedDirectSellers?(order: PurchaseOrder): Promise<readonly Address[]> | readonly Address[];
  /**
   * Called after signing and before the paid request is sent. Persist the digest here
   * (PAYMENT_PENDING) so a crash mid-flight can still be reconciled against the chain.
   */
  onAuthorized?(ctx: AuthorizedContext): Promise<void>;
  /** Called exactly once with whatever came back. Never triggers a retry. */
  onPaymentResult?(ctx: PaymentResultContext): Promise<void>;
}

export interface WrapFetchOptions {
  nodeAccount: NodeSigner;
  treasury: Address;
  adapter: PaymentFetchAdapter;
  /** Pass the result of verifyTokenDomain(); defaults to the pinned USDC domain. */
  domain?: TokenDomain;
  /** Treasury reservationWindow in seconds (caps validBefore). Default 600. */
  reservationWindowSeconds?: number;
  /** Clock in unix seconds; tests pin it. */
  now?: () => number;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function requestUrl(input: string | URL): string {
  return typeof input === "string" ? input : input.toString();
}

/**
 * Returns a fetch-compatible function. Non-402 responses pass through untouched. A 402 is
 * decoded, matched to an order via the adapter, checked with checkQuote, paid with one signed
 * retry, and the PAYMENT-RESPONSE is reported via adapter.onPaymentResult.
 *
 * Request bodies must be re-readable (string, Uint8Array, URLSearchParams); a stream body
 * cannot be sent twice.
 */
export function wrapFetch(fetchImpl: FetchLike, options: WrapFetchOptions): FetchLike {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  return async function paidFetch(input, init = {}) {
    const first = await fetchImpl(input, init);
    if (first.status !== 402) return first;

    const paymentRequired = parsePaymentRequired(first);
    const requirements = selectRequirements(paymentRequired);
    if (!requirements) return first;

    const url = requestUrl(input);
    const order = await options.adapter.resolveOrder({ url, paymentRequired, requirements });
    if (!order) return first;

    const approvedDirectSellers = options.adapter.approvedDirectSellers
      ? await options.adapter.approvedDirectSellers(order)
      : [];
    // Throws QuoteMismatchError on any disagreement; nothing below runs then.
    const quote = checkQuote(requirements, order, { approvedDirectSellers });

    const ttlSeconds = Math.max(1, Math.floor(quote.maxTimeoutSeconds));
    const signed = await signTransfer({
      nodeAccount: options.nodeAccount,
      treasury: options.treasury,
      to: quote.payTo,
      value: quote.value,
      ttlSeconds,
      nowSeconds: now(),
      ...(options.reservationWindowSeconds !== undefined
        ? { reservationWindowSeconds: options.reservationWindowSeconds }
        : {}),
      ...(options.domain ? { domain: options.domain } : {}),
    });

    const payload = buildPaymentPayload({ accepted: requirements, resource: paymentRequired.resource, signed });
    const header = buildPaymentHeader(payload);
    await options.adapter.onAuthorized?.({ order, quote, signed, payload, header });

    const headers = new Headers(init.headers);
    headers.set(header.name, header.value);

    // Exactly one paid attempt. From here on the outcome is decided on chain, not here.
    let second: Response;
    try {
      second = await fetchImpl(input, { ...init, headers });
    } catch (error) {
      await options.adapter.onPaymentResult?.({ order, signed, status: null, settlement: null, error });
      throw new PaymentOutcomeUnknownError(signed.digest, error);
    }

    let settlement: SettlementResponse | null = null;
    let settlementError: unknown;
    try {
      settlement = parsePaymentResponse(second);
    } catch (error) {
      settlementError = error instanceof PaymentRequiredParseError ? error : new PaymentRequiredParseError(String(error), error);
    }
    await options.adapter.onPaymentResult?.({
      order,
      signed,
      status: second.status,
      settlement,
      ...(settlementError !== undefined ? { error: settlementError } : {}),
    });
    return second;
  };
}
