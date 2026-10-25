import { z } from "zod";
import { AddressSchema, Bytes32Schema, HexSchema, UintStringSchema, CHAIN_ID } from "@overflow/schemas";
import { PaymentRequiredParseError } from "./errors";

// ---------------------------------------------------------------------------
// x402 v2 wire format.
// Source of truth: github.com/x402-foundation/x402, specs/x402-specification-v2.md,
// specs/transports-v2/http.md and specs/schemes/exact/scheme_exact_evm.md
// (typescript/packages/core/src/schemas/index.ts for the zod shapes).
// ---------------------------------------------------------------------------

export const X402_VERSION = 2 as const;

/** HTTP transport header names (specs/transports-v2/http.md "Header Summary"). */
export const X402_HEADERS = {
  /** Server -> client, on the 402: base64 JSON PaymentRequired. */
  paymentRequired: "PAYMENT-REQUIRED",
  /** Client -> server, on the paid retry: base64 JSON PaymentPayload. */
  paymentSignature: "PAYMENT-SIGNATURE",
  /** Server -> client, on the paid response: base64 JSON SettlementResponse. */
  paymentResponse: "PAYMENT-RESPONSE",
} as const;

export const X402_SCHEME_EXACT = "exact" as const;
/** CAIP-2 identifier for Base Sepolia. */
export const X402_NETWORK_BASE_SEPOLIA = `eip155:${CHAIN_ID}` as const;
/** Default and only asset transfer method we sign (scheme_exact_evm.md section 1). */
export const X402_ASSET_TRANSFER_METHOD_EIP3009 = "eip3009" as const;

const NonEmptyString = z.string().min(1);
// Other implementations send explicit `null` for absent optional fields; normalize to an optional key
// (z.preprocess keeps the output key optional, unlike .nullish().transform()).
const dropNull = (v: unknown) => (v === null ? undefined : v);
const nullishString = () => z.preprocess(dropNull, z.string().optional());
const nullishStringArray = () => z.preprocess(dropNull, z.array(z.string()).optional());
const nullishRecord = z.preprocess(dropNull, z.record(z.string(), z.unknown()).optional());

/** CAIP-2 `namespace:reference`. */
export const Caip2NetworkSchema = z
  .string()
  .regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/, "expected a CAIP-2 network id such as eip155:84532");

export const ResourceInfoSchema = z.object({
  url: NonEmptyString,
  description: nullishString(),
  mimeType: nullishString(),
  serviceName: nullishString(),
  tags: nullishStringArray(),
  iconUrl: nullishString(),
});
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>;

/** One entry of `accepts[]`. Amount is a decimal string of atomic units. */
export const PaymentRequirementsSchema = z.object({
  scheme: NonEmptyString,
  network: Caip2NetworkSchema,
  amount: NonEmptyString,
  asset: NonEmptyString,
  payTo: NonEmptyString,
  maxTimeoutSeconds: z.number().positive(),
  extra: nullishRecord,
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

/** Decoded `PAYMENT-REQUIRED` header. */
export const PaymentRequiredSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  error: nullishString(),
  resource: ResourceInfoSchema,
  accepts: z.array(PaymentRequirementsSchema).min(1),
  extensions: nullishRecord,
});
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

/** EIP-3009 authorization as it crosses the wire: every integer is a decimal string. */
export const Eip3009AuthorizationJsonSchema = z.object({
  from: AddressSchema,
  to: AddressSchema,
  value: UintStringSchema,
  validAfter: UintStringSchema,
  validBefore: UintStringSchema,
  nonce: Bytes32Schema,
});
export type Eip3009AuthorizationJson = z.infer<typeof Eip3009AuthorizationJsonSchema>;

/** 65-byte r||s||v signature. */
export const Signature65Schema = HexSchema.refine((v) => v.length === 2 + 65 * 2, "expected a 65-byte signature");

export const ExactEip3009PayloadSchema = z.object({
  signature: Signature65Schema,
  authorization: Eip3009AuthorizationJsonSchema,
});
export type ExactEip3009Payload = z.infer<typeof ExactEip3009PayloadSchema>;

/** Decoded `PAYMENT-SIGNATURE` header for scheme "exact" with the eip3009 transfer method. */
export const PaymentPayloadSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  resource: z.preprocess(dropNull, ResourceInfoSchema.optional()),
  accepted: PaymentRequirementsSchema,
  payload: ExactEip3009PayloadSchema,
  extensions: nullishRecord,
});
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

/** Decoded `PAYMENT-RESPONSE` header. `transaction` is "" on failure. */
export const SettlementResponseSchema = z
  .object({
    success: z.boolean(),
    errorReason: nullishString(),
    errorMessage: nullishString(),
    payer: nullishString(),
    transaction: z.string(),
    network: z.string(),
    amount: nullishString(),
  })
  .loose();
export type SettlementResponse = z.infer<typeof SettlementResponseSchema>;

// ---------------------------------------------------------------------------
// base64(JSON) codec used by all three headers
// ---------------------------------------------------------------------------

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function decodeBase64Json(value: string): unknown {
  if (!BASE64_RE.test(value) || value.length % 4 !== 0) {
    throw new PaymentRequiredParseError("header is not standard base64");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch (err) {
    throw new PaymentRequiredParseError("header is not standard base64", err);
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (err) {
    throw new PaymentRequiredParseError("header does not decode to JSON", err);
  }
}

// ---------------------------------------------------------------------------
// Parsing responses
// ---------------------------------------------------------------------------

/** Structural subset of fetch's Response that the parsers need. */
export interface HeaderSource {
  status?: number;
  headers: { get(name: string): string | null };
}

/**
 * Decode a seller's 402 per the x402 v2 HTTP transport: the PaymentRequired object lives in
 * the base64 `PAYMENT-REQUIRED` header. Bodies are a server concern and are ignored.
 */
export function parsePaymentRequired(response: HeaderSource): PaymentRequired {
  if (response.status !== undefined && response.status !== 402) {
    throw new PaymentRequiredParseError(`expected HTTP 402, got ${response.status}`);
  }
  const header = response.headers.get(X402_HEADERS.paymentRequired);
  if (!header) {
    throw new PaymentRequiredParseError(`missing ${X402_HEADERS.paymentRequired} header`);
  }
  const decoded = decodeBase64Json(header);
  const parsed = PaymentRequiredSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new PaymentRequiredParseError(
      `invalid PaymentRequired: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      parsed.error,
    );
  }
  return parsed.data;
}

/** Decode `PAYMENT-SIGNATURE` (used by tests and by the Overflow facilitator in a later prompt). */
export function parsePaymentPayload(headerValue: string): PaymentPayload {
  const decoded = decodeBase64Json(headerValue);
  const parsed = PaymentPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new PaymentRequiredParseError(
      `invalid PaymentPayload: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      parsed.error,
    );
  }
  return parsed.data;
}

/**
 * Decode `PAYMENT-RESPONSE`. Returns null when the header is absent. A present but malformed
 * header throws: the caller must then treat the payment outcome as unknown, not failed.
 */
export function parsePaymentResponse(response: HeaderSource): SettlementResponse | null {
  const header = response.headers.get(X402_HEADERS.paymentResponse);
  if (!header) return null;
  const decoded = decodeBase64Json(header);
  const parsed = SettlementResponseSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new PaymentRequiredParseError(
      `invalid SettlementResponse: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      parsed.error,
    );
  }
  return parsed.data;
}
