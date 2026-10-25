import {
  directApiOrder,
  PaymentOutcomeUnknownError,
  parsePaymentRequired,
  QuoteMismatchError,
  selectRequirements,
  wrapFetch,
  type FetchLike,
  type NodeSigner,
  type PaymentResultContext,
  type SignedTransferAuthorization,
} from "@overflow/payment-client";
import { AtomicAmountSchema, explorerUrl, formatUsdc, type Address, type AtomicAmount } from "@overflow/schemas";
import { effectivePolicy, predictRefusal, type ChainReader } from "./chain";
import { PolicyRefusedError, refusalFromVerify, verifyPayload, VERIFY_SOURCE } from "./facilitator";
import { refusal, type Refusal } from "./refusals";

export interface PayDeps {
  fetch: FetchLike;
  chain: ChainReader;
  signer: NodeSigner;
  treasury: Address;
  serviceUrl: string;
  now: () => number;
}

export type PayResult =
  | {
      paid: true;
      url: string;
      /** From the seller's PAYMENT-RESPONSE header (the facilitator's settle receipt). */
      txHash: string;
      explorerUrl: string;
      payer: Address | null;
      amountAtomic: AtomicAmount;
      amountUsdc: string;
      payTo: Address;
      nodeId: string | null;
      digest: string;
      httpStatus: number;
      body: unknown;
    }
  | {
      paid: false;
      kind: "refused";
      url: string;
      /** Whether an authorization was signed at all. */
      signed: boolean;
      /** Whether the seller ever received PAYMENT-SIGNATURE. */
      sentToSeller: boolean;
      refusal: Refusal;
      digest: string | null;
      /** Set when the seller's own settle attempt was broadcast and reverted (DEMO_MODE force broadcast). */
      txHash: string | null;
      httpStatus: number | null;
      priceAtomic: AtomicAmount | null;
      payTo: Address | null;
    }
  | {
      paid: false;
      kind: "unknown";
      url: string;
      digest: string;
      reason: string;
      httpStatus: number | null;
      txHash: string | null;
      instruction: "reconcile this digest against the chain (authorizationState) before anything else; never sign a new authorization for the same purchase";
    }
  | { paid: false; kind: "not-paywalled"; url: string; httpStatus: number; body: unknown }
  | { paid: false; kind: "no-acceptable-quote"; url: string; httpStatus: 402; note: string };

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * overflow_pay: the only tool that signs for a seller. One EIP-3009 authorization with from = the treasury,
 * gated three times before the seller sees it: maxAmount and the node's limits (chain reads), the owner
 * allowlist (chain read), and the facilitator's /verify simulation. Then exactly one paid request through
 * wrapFetch. Settlement is OverflowTreasury.settle(); the tx hash comes back in PAYMENT-RESPONSE.
 * Never retried: an unknown outcome returns the digest to reconcile.
 */
export async function pay(deps: PayDeps, url: string, maxAmountAtomic: string): Promise<PayResult> {
  const maxAmount = BigInt(AtomicAmountSchema.parse(maxAmountAtomic));
  // Flow state written by the adapter hooks below (an object, so TypeScript keeps the declared types).
  const st: {
    precheck: Refusal | null;
    quoted: { payTo: Address; amount: AtomicAmount } | null;
    signed: SignedTransferAuthorization | null;
    allowlisted: boolean;
    nodeId: string | null;
    result: PaymentResultContext | null;
  } = { precheck: null, quoted: null, signed: null, allowlisted: false, nodeId: null, result: null };

  const paidFetch = wrapFetch(deps.fetch, {
    nodeAccount: deps.signer,
    treasury: deps.treasury,
    now: deps.now,
    adapter: {
      async resolveOrder({ url: resourceUrl, requirements }) {
        const payTo = requirements.payTo as Address;
        const value = BigInt(requirements.amount);
        st.quoted = { payTo, amount: requirements.amount };
        if (value > maxAmount) {
          st.precheck = refusal("AboveMaxAmount", [requirements.amount, maxAmount.toString()], "client (maxAmount)", `the seller asks ${requirements.amount} atomic (${formatUsdc(requirements.amount)} USDC), above maxAmount ${maxAmount} atomic`);
          return null;
        }
        const [allow, policy] = await Promise.all([deps.chain.allowlist(payTo), effectivePolicy(deps.chain, deps.signer.address, deps.now())]);
        st.allowlisted = allow;
        st.nodeId = policy.nodeId;
        st.precheck = await predictRefusal(deps.chain, policy, value, payTo, allow);
        if (st.precheck || policy.nodeId === null) return null;
        return directApiOrder({ resourceUrl, payTo, amountAtomic: requirements.amount, treasury: deps.treasury, nodeId: Number(policy.nodeId), nowSeconds: deps.now() });
      },
      // Owner allowlist as read from the chain in resolveOrder; never from env or from the seller.
      approvedDirectSellers: (order) => (st.allowlisted ? [order.sellerAddress] : []),
      async onAuthorized(ctx) {
        st.signed = ctx.signed;
        const verify = await verifyPayload(deps.fetch, deps.serviceUrl, ctx.payload, ctx.quote.requirements);
        if (!verify.isValid) throw new PolicyRefusedError(refusalFromVerify(verify), ctx.signed.digest);
        st.nodeId = verify.nodeId;
      },
      async onPaymentResult(ctx) {
        st.result = ctx;
      },
    },
  });

  const refused = (r: Refusal, extra: { httpStatus?: number | null; txHash?: string | null; sentToSeller?: boolean } = {}): PayResult => ({
    paid: false,
    kind: "refused",
    url,
    signed: st.signed !== null,
    sentToSeller: extra.sentToSeller ?? false,
    refusal: r,
    digest: st.signed?.digest ?? null,
    txHash: extra.txHash ?? null,
    httpStatus: extra.httpStatus ?? null,
    priceAtomic: st.quoted?.amount ?? null,
    payTo: st.quoted?.payTo ?? null,
  });

  let response: Response;
  try {
    response = await paidFetch(url);
  } catch (err) {
    if (err instanceof PolicyRefusedError) return refused(err.refusal);
    if (err instanceof PaymentOutcomeUnknownError) {
      return {
        paid: false,
        kind: "unknown",
        url,
        digest: err.digest,
        reason: `the paid request failed in flight: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`,
        httpStatus: null,
        txHash: null,
        instruction: "reconcile this digest against the chain (authorizationState) before anything else; never sign a new authorization for the same purchase",
      };
    }
    if (err instanceof QuoteMismatchError) {
      return refused(refusal("QuoteMismatch", [err.field, String(err.expected), String(err.actual)], "client checkQuote (payment-client)", err.message));
    }
    throw err;
  }

  if (st.signed === null) {
    if (response.status !== 402) return { paid: false, kind: "not-paywalled", url, httpStatus: response.status, body: await readBody(response) };
    if (st.precheck) return refused(st.precheck, { httpStatus: 402 });
    const required = (() => {
      try {
        return parsePaymentRequired(response);
      } catch {
        return null;
      }
    })();
    if (required && selectRequirements(required) === null) {
      return { paid: false, kind: "no-acceptable-quote", url, httpStatus: 402, note: "the 402 offers no exact/USDC/Base Sepolia option" };
    }
    return refused(refusal("UnknownAgent", [deps.signer.address], "client-precheck (chain read: nodeOfKey)"), { httpStatus: 402 });
  }

  const digest: string = st.signed.digest;
  const payTo = st.quoted?.payTo ?? (st.signed.authorization.to as Address);
  const amount: AtomicAmount = st.quoted?.amount ?? st.signed.authorizationJson.value;
  const body = await readBody(response);
  const settlement = st.result?.settlement ?? null;
  if (response.status === 200 && settlement?.success) {
    return {
      paid: true,
      url,
      txHash: settlement.transaction,
      explorerUrl: explorerUrl("tx", settlement.transaction),
      payer: (settlement.payer as Address | undefined) ?? null,
      amountAtomic: amount,
      amountUsdc: formatUsdc(amount),
      payTo,
      nodeId: st.nodeId,
      digest,
      httpStatus: 200,
      body,
    };
  }
  const b = (body && typeof body === "object" ? body : {}) as { error?: string; decoded?: { name?: string; args?: string[]; decoded?: string; reason?: string }; txHash?: string; message?: string };
  if (response.status === 402 && b.error === "payment_blocked" && b.decoded?.name) {
    const args = b.decoded.args ?? [];
    return refused(
      { name: b.decoded.name, args, decoded: b.decoded.decoded ?? `${b.decoded.name}(${args.join(", ")})`, reason: b.decoded.reason ?? "", source: "treasury (seller's settle through the facilitator)" },
      { httpStatus: 402, txHash: b.txHash ?? null, sentToSeller: true },
    );
  }
  return {
    paid: false,
    kind: "unknown",
    url,
    digest,
    reason: b.message ?? `seller answered HTTP ${response.status} without a successful PAYMENT-RESPONSE (${VERIFY_SOURCE} had approved it)`,
    httpStatus: response.status,
    txHash: b.txHash ?? null,
    instruction: "reconcile this digest against the chain (authorizationState) before anything else; never sign a new authorization for the same purchase",
  };
}
