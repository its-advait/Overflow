import {
  buildPaymentPayload,
  PaymentRequiredSchema,
  parsePaymentRequired,
  selectRequirements,
  signTransfer,
  X402_NETWORK_BASE_SEPOLIA,
  type FetchLike,
  type NodeSigner,
  type PaymentRequired,
  type PaymentRequirements,
} from "@overflow/payment-client";
import { formatUsdc, USDC, type Address, type AtomicAmount } from "@overflow/schemas";
import { effectivePolicy, predictRefusal, type ChainReader, type EffectivePolicy } from "./chain";
import { refusalFromVerify, verifyPayload, VERIFY_SOURCE } from "./facilitator";
import { refusal, type Refusal } from "./refusals";

/** How long the quote's probe authorization stays valid. It is sent to SERVICE_URL only and expires unused. */
export const QUOTE_PROBE_TTL_SECONDS = 60;

export interface QuoteDeps {
  fetch: FetchLike;
  chain: ChainReader;
  signer: NodeSigner;
  treasury: Address;
  serviceUrl: string;
  now: () => number;
}

export type QuoteResult =
  | { url: string; paywalled: false; httpStatus: number; note: string }
  | {
      url: string;
      paywalled: true;
      /** False when the 402 offers nothing this client can pay (not exact/USDC/Base Sepolia). */
      payable: boolean;
      priceAtomic: AtomicAmount | null;
      priceUsdc: string | null;
      payTo: Address | null;
      asset: string | null;
      network: string | null;
      maxTimeoutSeconds: number | null;
      /** SIMULATED sellers mark their 402 bodies `simulated: true`; passed through when present. */
      simulatedSeller: boolean;
      /** Chain reads: owner allowlist for payTo and the signer's node policy. */
      allowlisted: boolean | null;
      withinPerCall: boolean | null;
      withinRemaining: boolean | null;
      budget: EffectivePolicy | null;
      policy: {
        /** The treasury's own answer from /verify (eth_call), or a labeled precheck when nothing was signed. */
        allowed: boolean;
        refusal: Refusal | null;
        payer: Address | null;
        nodeId: string | null;
        /** Digest of the probe authorization; it was never sent to the seller. */
        digest: string | null;
        validBefore: string | null;
        simulated: true;
        broadcast: false;
        source: string;
      };
    };

/** Read the 402 from the header (x402 v2) or, for sellers that only send a body, the JSON body. */
export async function readPaymentRequired(res: Response): Promise<{ required: PaymentRequired; simulatedSeller: boolean }> {
  let required: PaymentRequired | null = null;
  let simulatedSeller = false;
  try {
    required = parsePaymentRequired(res);
  } catch {
    required = null;
  }
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      const body: unknown = JSON.parse(text);
      if (body && typeof body === "object" && (body as { simulated?: unknown }).simulated === true) simulatedSeller = true;
      if (!required) {
        const parsed = PaymentRequiredSchema.safeParse(body);
        if (parsed.success) required = parsed.data;
      }
    } catch {
      /* not JSON */
    }
  }
  if (!required) throw new Error("the 402 carries neither a PAYMENT-REQUIRED header nor a PaymentRequired JSON body");
  return { required, simulatedSeller };
}

function payable(r: PaymentRequirements): Refusal | null {
  if (r.scheme !== "exact") return refusal("UnsupportedQuote", [r.scheme], "client (only the x402 exact scheme is supported)", `scheme ${r.scheme} is not "exact"`);
  if (r.network !== X402_NETWORK_BASE_SEPOLIA) return refusal("UnsupportedQuote", [r.network], "client (only Base Sepolia)", `network ${r.network} is not ${X402_NETWORK_BASE_SEPOLIA}`);
  if (r.asset.toLowerCase() !== USDC.address.toLowerCase()) return refusal("UnsupportedQuote", [r.asset], "client (only Base Sepolia USDC)", `asset ${r.asset} is not USDC ${USDC.address}`);
  return null;
}

/**
 * overflow_quote: fetch the 402, report price and payee, read the chain for the allowlist and the node's limits,
 * then ask the facilitator to simulate the exact payment (/verify). The probe is a real signature with a 60 s
 * validity, sent only to SERVICE_URL. The result is advisory: settle() decides at payment time.
 */
export async function quote(deps: QuoteDeps, url: string): Promise<QuoteResult> {
  const first = await deps.fetch(url);
  if (first.status !== 402) {
    return { url, paywalled: false, httpStatus: first.status, note: "no payment required; call it directly" };
  }
  const { required, simulatedSeller } = await readPaymentRequired(first);
  const requirements = selectRequirements(required);
  const base = { url, paywalled: true as const, simulatedSeller };
  const unpayable = (r: Refusal, req: PaymentRequirements | null) => ({
    ...base,
    payable: false,
    priceAtomic: req?.amount ?? null,
    priceUsdc: req ? formatUsdc(req.amount) : null,
    payTo: (req?.payTo as Address | undefined) ?? null,
    asset: req?.asset ?? null,
    network: req?.network ?? null,
    maxTimeoutSeconds: req?.maxTimeoutSeconds ?? null,
    allowlisted: null,
    withinPerCall: null,
    withinRemaining: null,
    budget: null,
    policy: { allowed: false, refusal: r, payer: null, nodeId: null, digest: null, validBefore: null, simulated: true as const, broadcast: false as const, source: r.source },
  });
  if (!requirements) {
    const offered = required.accepts[0] ?? null;
    return unpayable(refusal("UnsupportedQuote", [], "client", "the 402 offers no exact/USDC/Base Sepolia option"), offered);
  }
  const bad = payable(requirements);
  if (bad) return unpayable(bad, requirements);

  const payTo = requirements.payTo as Address;
  const value = BigInt(requirements.amount);
  const [allowlisted, budget] = await Promise.all([deps.chain.allowlist(payTo), effectivePolicy(deps.chain, deps.signer.address, deps.now())]);
  const withinPerCall = budget.nodeId !== null && value <= BigInt(budget.perCallAtomic);
  const withinRemaining = budget.nodeId !== null && value <= BigInt(budget.remainingAtomic);
  const predicted = await predictRefusal(deps.chain, budget, value, payTo, allowlisted);

  // The authoritative answer: the treasury's own checks, simulated by the facilitator. One short-lived signature.
  const signed = await signTransfer({ nodeAccount: deps.signer, treasury: deps.treasury, to: payTo, value, ttlSeconds: QUOTE_PROBE_TTL_SECONDS, nowSeconds: deps.now() });
  const payload = buildPaymentPayload({ accepted: requirements, resource: required.resource, signed });
  const verify = await verifyPayload(deps.fetch, deps.serviceUrl, payload, requirements);
  const verifyRefusal = verify.isValid ? null : refusalFromVerify(verify);

  return {
    ...base,
    payable: true,
    priceAtomic: requirements.amount,
    priceUsdc: formatUsdc(requirements.amount),
    payTo,
    asset: requirements.asset,
    network: requirements.network,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    allowlisted,
    withinPerCall,
    withinRemaining,
    budget,
    policy: {
      allowed: verify.isValid,
      // The treasury's revert wins; the chain-read prediction is only shown when /verify had no decoded error.
      refusal: verifyRefusal ?? (verify.isValid ? null : predicted),
      payer: verify.payer ?? null,
      nodeId: verify.isValid ? verify.nodeId : budget.nodeId,
      digest: signed.digest,
      validBefore: signed.authorizationJson.validBefore,
      simulated: true,
      broadcast: false,
      source: VERIFY_SOURCE,
    },
  };
}
