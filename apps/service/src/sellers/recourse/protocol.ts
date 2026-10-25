import { AddressSchema, AtomicAmountSchema, Bytes32Schema, UintStringSchema } from "@overflow/schemas";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Wire contract between the SIMULATED Recourse sellers (routes.ts) and the
// buyer side (orchestration/seller-order-terms.ts, scripts/recourse-demo.ts).
// Every body carries `simulated: true`. Money and uint fields travel as decimal
// strings; hashes as 0x bytes32.
//
// orderId derivation (docs/SPEC.md says k = keccak(sellerSecret, orderId, buyer),
// but orderId covers termsHash, which covers keyCommitment = keccak(k)): the
// seller draws a fresh random `salt`, derives k = perBuyerKey(sellerSecret,
// salt, buyer), builds termsHash with computeTermsHash and then
// orderId = computeOrderId({..., termsHash, salt}). The buyer recomputes both.
//
// Detection odds: a pre-funding sample of 20 chunk keys catches ONE swapped
// chunk only with p = 20/N (3.8% for N = 528), so the sample is a cheap sanity
// check, not the guarantee. The guarantee is the post-reveal full decrypt: once
// KeyRevealed lands the buyer decrypts every chunk against the manifest's
// plainLeaves and catches a swap with certainty, then complains on chain
// within the challenge window.
// ---------------------------------------------------------------------------

export const SellerBehaviorSchema = z.enum(["honest", "swap", "ghost"]);
export type SellerBehavior = z.infer<typeof SellerBehaviorSchema>;

/** The OrderTerms struct the factory received, field for field (IOverflowEscrow.OrderTerms). */
export const OrderTermsWireSchema = z.object({
  orderId: Bytes32Schema,
  buyer: AddressSchema,
  seller: AddressSchema,
  token: AddressSchema,
  amount: AtomicAmountSchema,
  bond: AtomicAmountSchema,
  termsHash: Bytes32Schema,
  manifestHash: Bytes32Schema,
  rootPlain: Bytes32Schema,
  rootCipher: Bytes32Schema,
  keyCommitment: Bytes32Schema,
  /** Unix seconds. */
  revealDeadline: UintStringSchema,
  /** Seconds. */
  challengeWindow: UintStringSchema,
  sourceKey: AddressSchema,
  /** Unix seconds. */
  minTimestamp: UintStringSchema,
  chunkCount: z.number().int().positive(),
});
export type OrderTermsWire = z.infer<typeof OrderTermsWireSchema>;

/** Per-order window overrides (seconds); the seller clamps them to these bounds and defaults to its env values. */
export const REVEAL_WINDOW_BOUNDS_S = { min: 60, max: 3600 } as const;
export const CHALLENGE_WINDOW_BOUNDS_S = { min: 30, max: 3600 } as const;

export const CreateOrderBodySchema = z.object({
  resourceId: z.string().min(1),
  buyerTreasury: AddressSchema,
  missionId: z.string().min(1),
  /** Optional reveal window in seconds; clamped to [60, 3600]. */
  revealWindowS: z.number().int().optional(),
  /** Optional challenge window in seconds; clamped to [30, 3600]. */
  challengeWindowS: z.number().int().optional(),
});
export type CreateOrderBody = z.infer<typeof CreateOrderBodySchema>;

export const CreateOrderResponseSchema = z.object({
  simulated: z.literal(true),
  orderId: Bytes32Schema,
  escrowAddress: AddressSchema,
  sellerId: z.string().min(1),
  resourceId: z.string().min(1),
  missionId: z.string().min(1),
  /** Random bytes32 the buyer needs to recompute orderId. */
  salt: Bytes32Schema,
  terms: OrderTermsWireSchema,
  /** factory.create receipt. */
  createTxHash: Bytes32Schema,
  /** True when this POST returned an order created earlier for the same (mission, resource, buyer). */
  replayed: z.boolean(),
  cipherUrl: z.string().min(1),
  sampleUrl: z.string().min(1),
  resourceUrl: z.string().min(1),
});
export type CreateOrderResponse = z.infer<typeof CreateOrderResponseSchema>;

export const SampleBodySchema = z.object({
  indices: z.array(z.number().int().nonnegative()).min(1).max(64),
});
export const SampleResponseSchema = z.object({
  simulated: z.literal(true),
  orderId: Bytes32Schema,
  reveals: z.array(z.object({ index: z.number().int().nonnegative(), chunkKey: Bytes32Schema })),
});

export const BehaviorResponseSchema = z.object({
  simulated: z.literal(true),
  sellerId: z.string().min(1),
  sellerAddress: AddressSchema,
  behavior: SellerBehaviorSchema,
  options: z.array(SellerBehaviorSchema),
});
export const PutBehaviorBodySchema = z.object({ behavior: SellerBehaviorSchema });

/** Maximum sampled chunk keys per request. */
export const MAX_SAMPLE = 64;
