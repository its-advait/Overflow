import { z } from "zod";
import { AddressSchema, AtomicAmountSchema, Bytes32Schema, HexSchema, IdSchema, IsoDateTimeSchema, UintStringSchema } from "./primitives";
import { LicenseSchema } from "./resource";

// ---------------------------------------------------------------------------
// Judge controls (docs/SPEC.md "A judge's own scenario"): the shapes behind
// GET/PUT /api/settings/sellers, POST /api/settings/orders, GET /api/settings/network
// and PUT /api/resources/:id. Everything a seller control changes is SIMULATED
// (the sellers are the local Anvil run's fixtures); the network block is read
// from the chain, never typed in.
// ---------------------------------------------------------------------------

export const SellerBehaviourSchema = z.enum(["honest", "ghost", "swap"]);
export type SellerBehaviour = z.infer<typeof SellerBehaviourSchema>;

export const RecourseSellerViewSchema = z.object({
  /** Position in RECOURSE_SELLER_KEYS. */
  index: z.number().int().nonnegative(),
  address: AddressSchema,
  /** What this seller will do on its NEXT order (in-memory; a service restart returns to the defaults). */
  behaviour: SellerBehaviourSchema,
  label: z.string().min(1),
  /** From the indexer's seller_history: the factory recorded a proven cheat, so the treasury refuses this payee. */
  flagged: z.boolean(),
  simulated: z.literal(true),
});
export type RecourseSellerView = z.infer<typeof RecourseSellerViewSchema>;

export const SellersResponseSchema = z.object({
  sellers: z.array(RecourseSellerViewSchema),
  simulated: z.literal(true),
  note: z.string(),
});
export type SellersResponse = z.infer<typeof SellersResponseSchema>;

export const SetSellerBehaviourBodySchema = z.object({ behaviour: SellerBehaviourSchema });
export type SetSellerBehaviourBody = z.infer<typeof SetSellerBehaviourBodySchema>;

export const RunOrderBodySchema = z.object({
  sellerAddress: AddressSchema,
  listingId: IdSchema,
  /** Seller's bond in atomic USDC; default price / 5. */
  bondAtomic: AtomicAmountSchema.optional(),
});
export type RunOrderBody = z.infer<typeof RunOrderBodySchema>;

/** What the runner did for one order. Statuses are the indexer's: read GET /api/escrow/:purchaseId. */
export const OrderOutcomeSchema = z.object({
  behaviour: SellerBehaviourSchema,
  listingId: IdSchema,
  purchaseId: IdSchema,
  escrow: AddressSchema,
  orderId: Bytes32Schema,
  seller: AddressSchema,
  amountAtomic: AtomicAmountSchema,
  bondAtomic: AtomicAmountSchema,
  sampleVerdict: z.enum(["buy", "skip"]),
  /** The runner's last step for this order; the chain and the indexer decide the status. */
  lastStep: z.string(),
  txs: z.record(z.string(), Bytes32Schema),
});
export type OrderOutcomeView = z.infer<typeof OrderOutcomeSchema>;

export const RunOrderResponseSchema = z.object({
  order: OrderOutcomeSchema,
  simulated: z.literal(true),
  note: z.string(),
});
export type RunOrderResponse = z.infer<typeof RunOrderResponseSchema>;

export const NetworkInfoSchema = z.object({
  chainId: z.number().int(),
  /** "local Anvil fork" when the RPC answers anvil_nodeInfo, else "Base Sepolia". */
  network: z.enum(["local Anvil fork", "Base Sepolia"]),
  /** Host only; an RPC URL may carry an API key. */
  rpc: z.string(),
  treasury: AddressSchema,
  escrowFactory: AddressSchema.nullable(),
  /** OverflowTreasury.owner(): the controller's wallet. */
  owner: AddressSchema,
  floorAtomic: AtomicAmountSchema,
  reservationWindowSeconds: UintStringSchema,
  reservedTotalAtomic: AtomicAmountSchema,
  nodeCount: UintStringSchema,
  token: z.object({ address: AddressSchema, name: z.string(), version: z.string(), decimals: z.number().int(), domainSeparator: HexSchema }),
  /** Holds gas ETH only, never USDC. */
  relayer: AddressSchema,
  blockNumber: UintStringSchema,
  readAt: IsoDateTimeSchema,
  deployBlock: UintStringSchema.optional(),
  deployedAt: IsoDateTimeSchema.optional(),
});
export type NetworkInfo = z.infer<typeof NetworkInfoSchema>;

/** A judge's edit of a SIMULATED listing: the next Oracle/Fusion run and the next order read the new values. */
export const UpdateResourceBodySchema = z
  .object({
    priceAtomic: AtomicAmountSchema.optional(),
    license: LicenseSchema.optional(),
    seats: z.number().int().min(1).optional(),
  })
  .refine((b) => b.priceAtomic !== undefined || b.license !== undefined || b.seats !== undefined, { message: "nothing to update: give priceAtomic, license or seats" });
export type UpdateResourceBody = z.infer<typeof UpdateResourceBodySchema>;
