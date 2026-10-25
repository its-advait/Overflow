import type { z } from "zod";
import { PaymentRequiredParseError, QuoteMismatchError } from "./errors";
import type { SignedTransferAuthorization } from "./authorization";
import {
  PaymentPayloadSchema,
  X402_HEADERS,
  X402_VERSION,
  encodeBase64Json,
  type PaymentPayload,
  type PaymentRequirements,
  type ResourceInfo,
} from "./x402";

// ---------------------------------------------------------------------------
// PAYMENT-SIGNATURE: base64(JSON PaymentPayload) with `accepted` echoing the seller's
// requirements and `payload` = { signature, authorization } (scheme_exact_evm.md section 1).
// ---------------------------------------------------------------------------

export interface BuildPaymentPayloadInput {
  accepted: PaymentRequirements;
  resource?: ResourceInfo;
  signed: SignedTransferAuthorization;
}

/** Build the PaymentPayload. Refuses if the signed authorization and `accepted` disagree. */
export function buildPaymentPayload(input: BuildPaymentPayloadInput): PaymentPayload {
  const { accepted, signed } = input;
  if (accepted.payTo.toLowerCase() !== signed.authorization.to.toLowerCase()) {
    throw new QuoteMismatchError("payTo", signed.authorization.to, accepted.payTo);
  }
  if (!/^(0|[1-9]\d*)$/.test(accepted.amount) || BigInt(accepted.amount) !== signed.authorization.value) {
    throw new QuoteMismatchError("amount", signed.authorization.value.toString(), accepted.amount);
  }
  const payload: z.input<typeof PaymentPayloadSchema> = {
    x402Version: X402_VERSION,
    ...(input.resource ? { resource: input.resource } : {}),
    accepted,
    payload: { signature: signed.signature, authorization: signed.authorizationJson },
  };
  const parsed = PaymentPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PaymentRequiredParseError(
      `built an invalid PaymentPayload: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      parsed.error,
    );
  }
  return parsed.data;
}

export interface PaymentHeader {
  name: typeof X402_HEADERS.paymentSignature;
  value: string;
}

/** The header to attach to the paid retry. */
export function buildPaymentHeader(payload: PaymentPayload): PaymentHeader {
  return { name: X402_HEADERS.paymentSignature, value: encodeBase64Json(payload) };
}
