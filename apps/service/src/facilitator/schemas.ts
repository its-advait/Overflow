import { z } from "zod";
import { AddressSchema, Bytes32Schema, UintStringSchema } from "@overflow/schemas";
import { AuthorizationSchema, ChildParamsSchema, PauseChildSchema, SignatureSchema } from "@overflow/payment-client";

/** x402 v2 facilitator-shaped bodies, so the same client code can later target Coinbase's facilitator. */
export const PaymentRequirementsSchema = z.object({
  scheme: z.literal("exact").default("exact"),
  network: z.string().default("eip155:84532"),
  payTo: AddressSchema,
  amount: UintStringSchema, // atomic USDC, decimal string
  asset: AddressSchema,
});

export const PaymentPayloadSchema = z.object({
  x402Version: z.number().int().default(2),
  scheme: z.literal("exact").default("exact"),
  network: z.string().default("eip155:84532"),
  payload: z.object({ authorization: AuthorizationSchema, signature: SignatureSchema }),
});

export const VerifyBodySchema = z.object({
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema.optional(),
});
export type VerifyBody = z.infer<typeof VerifyBodySchema>;

export const SettleBodySchema = VerifyBodySchema.extend({
  /** DEMO ONLY (DEMO_MODE=true + x-demo-token): broadcast even when the simulation reverts, so the revert lands onchain. */
  forceBroadcast: z.boolean().default(false),
});
export type SettleBody = z.infer<typeof SettleBodySchema>;

export const ReleaseBodySchema = z.object({ digest: Bytes32Schema });

export const DelegateBodySchema = z.object({ child: ChildParamsSchema, signature: SignatureSchema });

export const PauseChildBodySchema = PauseChildSchema.extend({ signature: SignatureSchema });

export const BypassBodySchema = z.object({ authorization: AuthorizationSchema, signature: SignatureSchema });

export function invalidRequest(issues: z.core.$ZodIssue[]) {
  return {
    ok: false as const,
    error: {
      name: "InvalidRequest",
      reason: issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; "),
    },
  };
}
