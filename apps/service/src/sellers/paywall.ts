import {
  encodeBase64Json,
  parsePaymentPayload,
  PaymentRequiredParseError,
  PaymentRequiredSchema,
  SettlementResponseSchema,
  X402_HEADERS,
  X402_NETWORK_BASE_SEPOLIA,
  X402_SCHEME_EXACT,
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
} from "@overflow/payment-client";
import { explorerUrl, USDC, type Address, type AtomicAmount } from "@overflow/schemas";
import type { Context, MiddlewareHandler } from "hono";
import type { Facilitator, SettleOutcome } from "../facilitator/settle.js";
import { FORCE_BROADCAST_HEADER, QUOTE_TIMEOUT_SECONDS } from "./prices.js";

// ---------------------------------------------------------------------------
// x402 v2 paywall for the SIMULATED sellers (Leash apps/seller/paywall.ts, ported
// to Hono + USDC). Unpaid: 402 + PAYMENT-REQUIRED. Paid: the in-process
// facilitator submits treasury.settle(); the three outcomes map to three
// distinct responses and nothing here reports success without a receipt.
// ---------------------------------------------------------------------------

export type SellerEnv = {
  Variables: {
    /** Set by the paywall once settle() confirmed on chain; handlers may echo it. */
    settlement?: Extract<SettleOutcome, { outcome: "paid" }>;
  };
};

export interface PaywallOptions {
  /** Fixed price, or derived from the request (the Recourse /r route prices per order). */
  amountAtomic: AtomicAmount | ((c: Context) => AtomicAmount);
  /** Payee for this request; null answers 503 (fixture not configured). */
  payTo: (c: Context) => Address | null;
  description: string;
  /** Keep the query string in the 402 resource url (default: pathname only). */
  keepQuery?: boolean | undefined;
  sellerUrl: string;
  facilitator: Facilitator | null;
  /** When null, paid retries answer 503 with this reason. */
  facilitatorUnavailableReason?: string | undefined;
  allowForceBroadcast: boolean;
}

export function requirementFor(payTo: Address, amountAtomic: AtomicAmount): PaymentRequirements {
  return {
    scheme: X402_SCHEME_EXACT,
    network: X402_NETWORK_BASE_SEPOLIA,
    asset: USDC.address,
    payTo,
    amount: amountAtomic,
    maxTimeoutSeconds: QUOTE_TIMEOUT_SECONDS,
    extra: { name: USDC.name, version: USDC.version },
  };
}

export function buildPaymentRequired(input: { resourceUrl: string; description: string; requirement: PaymentRequirements }): PaymentRequired {
  // Validated before encoding so a shape drift is a 500 here, never a malformed 402.
  return PaymentRequiredSchema.parse({
    x402Version: X402_VERSION,
    error: "payment_required",
    resource: { url: input.resourceUrl, description: input.description, mimeType: "application/json" },
    accepts: [input.requirement],
  });
}

export function respond402(c: Context, required: PaymentRequired, body: Record<string, unknown>): Response {
  c.header(X402_HEADERS.paymentRequired, encodeBase64Json(required));
  return c.json({ ...required, ...body, simulated: true }, 402);
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The signed payload must be for exactly this route's requirement; otherwise the facilitator is never consulted. */
export function payloadMatchesRequirement(payload: PaymentPayload, requirement: PaymentRequirements): string | undefined {
  const a = payload.payload.authorization;
  if (!same(payload.accepted.payTo, requirement.payTo)) return "accepted.payTo is not this route's payee";
  if (payload.accepted.amount !== requirement.amount) return "accepted.amount is not this route's price";
  if (!same(payload.accepted.asset, requirement.asset)) return "accepted.asset is not USDC";
  if (payload.accepted.network !== requirement.network) return "accepted.network is not Base Sepolia";
  if (!same(a.to, requirement.payTo)) return "authorization.to is not this route's payee";
  if (BigInt(a.value) !== BigInt(requirement.amount)) return "authorization.value is not this route's price";
  return undefined;
}

export function paywall(opts: PaywallOptions): MiddlewareHandler<SellerEnv> {
  return async (c, next) => {
    const payTo = opts.payTo(c);
    if (!payTo) {
      return c.json({ error: "fixture_not_configured", message: `${opts.description}: payee address is not configured`, simulated: true }, 503);
    }
    const amountAtomic = typeof opts.amountAtomic === "function" ? opts.amountAtomic(c) : opts.amountAtomic;
    const requirement = requirementFor(payTo, amountAtomic);
    const url = new URL(c.req.url);
    const resourceUrl = `${opts.sellerUrl}${url.pathname}${opts.keepQuery ? url.search : ""}`;
    const required = buildPaymentRequired({ resourceUrl, description: opts.description, requirement });

    const sigHeader = c.req.header(X402_HEADERS.paymentSignature);
    if (!sigHeader) return respond402(c, required, {});

    let payload: PaymentPayload;
    try {
      payload = parsePaymentPayload(sigHeader);
    } catch (err) {
      const message = err instanceof PaymentRequiredParseError ? err.message : String(err);
      return c.json({ error: "bad_payment_header", message: `PAYMENT-SIGNATURE: ${message}`, simulated: true }, 400);
    }

    const mismatch = payloadMatchesRequirement(payload, requirement);
    if (mismatch) {
      return respond402(c, required, {
        error: "payment_blocked",
        decoded: { name: "InvalidPayment", args: [], decoded: "InvalidPayment()", reason: mismatch },
      });
    }

    if (!opts.facilitator) {
      return c.json(
        { error: "facilitator_unavailable", message: opts.facilitatorUnavailableReason ?? "no facilitator is configured", simulated: true },
        503,
      );
    }

    const forceRequested = c.req.header(FORCE_BROADCAST_HEADER) === "1";
    const forceBroadcast = forceRequested && opts.allowForceBroadcast;
    if (forceRequested && !opts.allowForceBroadcast) console.warn(`[sellers] ${FORCE_BROADCAST_HEADER} ignored: DEMO_MODE is not "true"`);

    const outcome = await opts.facilitator.settle({ payload, requirements: requirement, forceBroadcast });
    switch (outcome.outcome) {
      case "blocked":
        return respond402(c, required, {
          error: "payment_blocked",
          decoded: outcome.decoded,
          ...(outcome.txHash ? { txHash: outcome.txHash, explorerUrl: explorerUrl("tx", outcome.txHash) } : {}),
          ...(outcome.digest ? { digest: outcome.digest } : {}),
          forceBroadcast,
        });
      case "unknown":
        return c.json(
          {
            error: "payment_outcome_unknown",
            message: `${outcome.reason}; reconcile digest ${outcome.digest} against the chain before any retry`,
            digest: outcome.digest,
            ...(outcome.txHash ? { txHash: outcome.txHash, explorerUrl: explorerUrl("tx", outcome.txHash) } : {}),
            simulated: true,
          },
          502,
        );
      case "paid": {
        const settlement = SettlementResponseSchema.parse({
          success: true,
          transaction: outcome.txHash,
          network: X402_NETWORK_BASE_SEPOLIA,
          payer: outcome.payer,
          amount: requirement.amount,
        });
        c.header(X402_HEADERS.paymentResponse, encodeBase64Json(settlement));
        c.set("settlement", outcome);
        await next();
        return;
      }
    }
  };
}
