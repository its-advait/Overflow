import { z } from "zod";
import { AddressSchema, Bytes32Schema, IsoDateTimeSchema, PaymentPathSchema, UintStringSchema, USDC } from "@overflow/schemas";
import type { PaymentStatus, PurchaseOrder, PurchaseStatus } from "@overflow/schemas";
import { AuthorizationSchema, SignatureSchema } from "../typed-data";

export const X402_NETWORK = "eip155:84532" as const;

/** One `accepts` entry of an x402 v2 402 response (the quote). */
export const PaymentRequirementsSchema = z.object({
  scheme: z.literal("exact"),
  network: z.literal(X402_NETWORK),
  asset: AddressSchema,
  payTo: AddressSchema,
  amount: UintStringSchema,
  maxTimeoutSeconds: z.number().int().positive().max(86_400).optional(),
  extra: z.object({ name: z.string().optional(), version: z.string().optional() }).passthrough().optional(),
  /** Resource URL the quote is for (x402 v2 puts it on the envelope; we copy it here). */
  resource: z.string().optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

/** The 402 body (or base64 `PAYMENT-REQUIRED` header) a seller returns. */
export const PaymentRequiredSchema = z.object({
  x402Version: z.number().int(),
  error: z.string().optional(),
  resource: z.union([z.string(), z.object({ url: z.string() }).passthrough()]).optional(),
  accepts: z.array(z.record(z.string(), z.unknown())),
});
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

/** The one authorization a purchase may ever have, as signed by the paying node key. */
export const PreparedPaymentSchema = z.object({
  purchaseId: z.string().min(1),
  path: PaymentPathSchema,
  requirements: PaymentRequirementsSchema,
  authorization: AuthorizationSchema,
  signature: SignatureSchema,
  digest: Bytes32Schema,
  createdAt: IsoDateTimeSchema,
});
export type PreparedPayment = z.infer<typeof PreparedPaymentSchema>;

export const PaymentSubmissionSchema = z.object({
  purchaseId: z.string().min(1),
  path: PaymentPathSchema,
  status: z.string(),
  digest: Bytes32Schema,
  txHash: Bytes32Schema.optional(),
  explorerUrl: z.string().optional(),
  reason: z.string().optional(),
  decodedRevert: z.string().optional(),
  submittedAt: IsoDateTimeSchema,
});
export type PaymentSubmission = Omit<z.infer<typeof PaymentSubmissionSchema>, "status"> & { status: PurchaseStatus };

/** docs/SPEC.md "One payment interface, two paths", verbatim. */
export interface PaymentAdapter {
  getPaymentRequirements(resourceUrl: string): Promise<PaymentRequirements>;
  preparePayment(purchaseId: string): Promise<PreparedPayment>; // node key signs EIP-3009, from = treasury
  submitPayment(purchaseId: string): Promise<PaymentSubmission>;
  reconcilePayment(purchaseId: string): Promise<PaymentStatus>; // reads the chain before any retry
}

export type TxReceiptView = { status: "success" | "reverted"; blockNumber: bigint } | null;

/** The chain reads an adapter needs; the service's viem client satisfies it, tests pass fakes. */
export interface AdapterChainReader {
  authorizationState(authorizer: `0x${string}`, nonce: `0x${string}`): Promise<boolean>;
  getTransactionReceipt(hash: `0x${string}`): Promise<TxReceiptView>;
}

export class PurchaseNotFoundError extends Error {
  constructor(id: string) {
    super(`purchase ${id} not found`);
    this.name = "PurchaseNotFoundError";
  }
}
/** RULE: no adapter may create a second authorization for a purchase that has one in flight. */
export class AuthorizationInFlightError extends Error {
  constructor(id: string, digest: `0x${string}`, status: PurchaseStatus) {
    super(`purchase ${id} already has authorization ${digest} (status ${status}); reconcilePayment is the only retry path`);
    this.name = "AuthorizationInFlightError";
  }
}
export class AlreadySubmittedError extends Error {
  constructor(id: string, status: PurchaseStatus) {
    super(`purchase ${id} was already submitted (status ${status}); call reconcilePayment, never submit again`);
    this.name = "AlreadySubmittedError";
  }
}
/** The seller's quote differs from the purchase order: refuse to sign. */
export class QuoteMismatchError extends Error {
  constructor(public readonly mismatches: string[]) {
    super(`quote does not match the purchase order: ${mismatches.join("; ")}`);
    this.name = "QuoteMismatchError";
  }
}

export function quoteMismatches(order: PurchaseOrder, q: PaymentRequirements): string[] {
  const out: string[] = [];
  const payTo = q.payTo.toLowerCase();
  if (payTo !== order.escrowAddress.toLowerCase() && payTo !== order.sellerAddress.toLowerCase()) {
    out.push(`payTo ${q.payTo} is neither the escrow ${order.escrowAddress} nor the seller ${order.sellerAddress}`);
  }
  if (q.amount !== order.amountAtomic) out.push(`amount ${q.amount} != order ${order.amountAtomic}`);
  if (q.asset.toLowerCase() !== order.tokenAddress.toLowerCase() || q.asset.toLowerCase() !== USDC.address.toLowerCase()) {
    out.push(`asset ${q.asset} is not the order's USDC ${order.tokenAddress}`);
  }
  if (q.network !== X402_NETWORK) out.push(`network ${q.network} is not ${X402_NETWORK}`);
  return out;
}
