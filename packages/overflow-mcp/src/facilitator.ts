import { X402_NETWORK_BASE_SEPOLIA, type FetchLike, type PaymentPayload, type PaymentRequirements } from "@overflow/payment-client";
import { AddressSchema, CHAIN_ID, USDC, type Address, type Hex } from "@overflow/schemas";
import { z } from "zod";
import { reasonFor, type Refusal } from "./refusals";

export const HealthSchema = z
  .object({
    ok: z.boolean(),
    chainId: z.number(),
    treasury: AddressSchema,
    usdc: AddressSchema,
  })
  .loose();
export type Health = z.infer<typeof HealthSchema>;

export class FacilitatorError extends Error {
  constructor(
    public readonly route: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`facilitator ${route} answered HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "FacilitatorError";
  }
}

export async function fetchHealth(fetch: FetchLike, serviceUrl: string): Promise<Health> {
  const res = await fetch(`${serviceUrl}/health`);
  const text = await res.text();
  if (!res.ok) throw new FacilitatorError("/health", res.status, text);
  return HealthSchema.parse(JSON.parse(text));
}

/** Boot invariants: the service settles on Base Sepolia USDC through the treasury we sign `from =`. */
export function assertHealth(health: Health, treasuryPin: Address | null): Address {
  if (health.chainId !== CHAIN_ID) throw new Error(`service is on chain ${health.chainId}; this server only knows Base Sepolia ${CHAIN_ID}`);
  if (health.usdc.toLowerCase() !== USDC.address.toLowerCase()) throw new Error(`service token ${health.usdc} is not Base Sepolia USDC ${USDC.address}`);
  if (treasuryPin && treasuryPin.toLowerCase() !== health.treasury.toLowerCase()) {
    throw new Error(`TREASURY pin ${treasuryPin} differs from the service's treasury ${health.treasury}; refusing to sign for either`);
  }
  return health.treasury;
}

export const DecodedRevertSchema = z
  .object({
    name: z.string(),
    args: z.array(z.string()).default([]),
    reason: z.string(),
    source: z.string().optional(),
    selector: z.string().optional(),
    decoded: z.string().optional(),
  })
  .loose();

export const VerifyResultSchema = z.union([
  z.object({ isValid: z.literal(true), payer: AddressSchema, nodeId: z.string(), digest: z.string() }).loose(),
  z.object({ isValid: z.literal(false), invalidReason: z.string(), decoded: DecodedRevertSchema.optional(), payer: AddressSchema.optional() }).loose(),
]);
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

export const VERIFY_SOURCE = "treasury (facilitator POST /verify: eth_call simulation of settle(); nothing broadcast)";

/** A refused /verify as a Refusal. Prechecks (no `decoded`) become InvalidPayment with the facilitator's reason. */
export function refusalFromVerify(v: Extract<VerifyResult, { isValid: false }>): Refusal {
  if (v.decoded) {
    const args = v.decoded.args ?? [];
    return {
      name: v.decoded.name,
      args,
      decoded: v.decoded.decoded ?? `${v.decoded.name}(${args.join(", ")})`,
      reason: v.decoded.reason || reasonFor(v.decoded.name, args),
      source: VERIFY_SOURCE,
    };
  }
  return { name: "InvalidPayment", args: [], decoded: "InvalidPayment()", reason: v.invalidReason, source: "facilitator /verify precheck" };
}

export class PolicyRefusedError extends Error {
  constructor(
    public readonly refusal: Refusal,
    public readonly digest: Hex,
  ) {
    super(`treasury refuses this payment: ${refusal.decoded}: ${refusal.reason}`);
    this.name = "PolicyRefusedError";
  }
}

/**
 * Ask the facilitator to simulate settle() for a signed authorization. The signature is real (the facilitator
 * recovers the signer and runs the treasury's checks as the relayer) but the call is an eth_call: nothing moves.
 * The payload goes to SERVICE_URL only, never to a seller.
 */
export async function verifyPayload(fetch: FetchLike, serviceUrl: string, payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult> {
  const body = {
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network: X402_NETWORK_BASE_SEPOLIA,
      payload: { authorization: payload.payload.authorization, signature: payload.payload.signature },
    },
    paymentRequirements: {
      scheme: requirements.scheme,
      network: requirements.network,
      payTo: requirements.payTo,
      amount: requirements.amount,
      asset: requirements.asset,
    },
  };
  const res = await fetch(`${serviceUrl}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new FacilitatorError("/verify", res.status, text);
  return VerifyResultSchema.parse(JSON.parse(text));
}
