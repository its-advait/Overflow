import type { Hex } from "viem";
import { USDC } from "@overflow/schemas";
import { PaymentRequiredSchema, PaymentRequirementsSchema, X402_NETWORK, type PaymentRequirements, type PreparedPayment } from "./types";

export const b64encode = (o: unknown): string => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
export const b64decode = <T>(s: string): T => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as T;

export class NoAcceptableQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAcceptableQuoteError";
  }
}

/** GET the resource, expect 402, pick the exact/Base Sepolia/USDC quote. Never signs anything. */
export async function fetchPaymentRequirements(fetchFn: typeof fetch, resourceUrl: string): Promise<PaymentRequirements> {
  const res = await fetchFn(resourceUrl, { method: "GET" });
  if (res.status !== 402) throw new NoAcceptableQuoteError(`${resourceUrl} answered ${res.status}, expected 402`);
  const header = res.headers.get("payment-required");
  let raw: unknown;
  if (header) {
    try {
      raw = b64decode(header);
    } catch {
      raw = undefined;
    }
  }
  if (raw === undefined) raw = await res.json().catch(() => undefined);
  const parsed = PaymentRequiredSchema.safeParse(raw);
  if (!parsed.success) throw new NoAcceptableQuoteError(`${resourceUrl}: malformed 402 body`);
  const resource = typeof parsed.data.resource === "string" ? parsed.data.resource : (parsed.data.resource?.url ?? resourceUrl);
  for (const a of parsed.data.accepts) {
    const q = PaymentRequirementsSchema.safeParse({ ...a, resource });
    if (q.success && q.data.scheme === "exact" && q.data.network === X402_NETWORK && q.data.asset.toLowerCase() === USDC.address.toLowerCase()) return q.data;
  }
  throw new NoAcceptableQuoteError(`${resourceUrl}: no exact/${X402_NETWORK}/USDC quote among ${parsed.data.accepts.length} offers`);
}

/** x402 v2 payment payload (what goes into the PAYMENT-SIGNATURE header and into facilitator bodies). */
export function paymentPayload(p: PreparedPayment) {
  return {
    x402Version: 2,
    scheme: "exact" as const,
    network: X402_NETWORK,
    accepted: p.requirements,
    payload: { authorization: p.authorization, signature: p.signature },
  };
}

export type PaymentResponse = { success: boolean; transaction?: Hex; network?: string; payer?: string; errorReason?: string };

export function decodePaymentResponse(header: string | null): PaymentResponse | undefined {
  if (!header) return undefined;
  try {
    return b64decode<PaymentResponse>(header);
  } catch {
    return undefined;
  }
}
