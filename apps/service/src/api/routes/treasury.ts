import { AddressSchema, AtomicAmountSchema, atomicToBigInt, EscrowStatusSchema, IdSchema, IsoDateTimeSchema, UintStringSchema, type EscrowOrder } from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { respond, type ApiEnv } from "../http.js";
import { NotWiredError } from "../ports.js";

// ---------------------------------------------------------------------------
// GET /api/treasury: the overview's money cards. Two numbers come from the
// chain at one block (USDC balanceOf(treasury), reservedTotal()); the escrow
// commitment comes from the escrow_orders table, which mirrors confirmed
// escrow events. When no chain reader is wired the chain part is null with
// the reason, never a stale or invented number.
// ---------------------------------------------------------------------------

const ChainSnapshotSchema = z.object({
  blockNumber: UintStringSchema,
  /** USDC.balanceOf(treasury). */
  balanceAtomic: AtomicAmountSchema,
  /** OverflowTreasury.reservedTotal(): promised to open reservations; the floor check counts it. */
  reservedTotalAtomic: AtomicAmountSchema,
  usdc: AddressSchema,
  readAt: IsoDateTimeSchema,
});

const OpenEscrowSchema = z.object({
  purchaseId: IdSchema,
  escrowAddress: AddressSchema,
  status: EscrowStatusSchema,
  amountAtomic: AtomicAmountSchema,
  /** True once OrderFunded was indexed (Funded or Revealed): the USDC sits in the escrow contract. */
  funded: z.boolean(),
});

export const TreasuryResponse = z.object({
  treasury: AddressSchema.nullable(),
  chain: ChainSnapshotSchema.nullable(),
  /** Why `chain` is null (no RPC / deployments). Absent when `chain` is set. */
  chainUnavailable: z.string().optional(),
  escrow: z.object({
    /** Orders not yet Settled or Refunded, including Created ones that hold no USDC yet. */
    openOrders: z.number().int().min(0),
    /** Open orders the chain has funded (Funded, Revealed). */
    fundedOrders: z.number().int().min(0),
    /** Σ amount over funded open orders: USDC held by escrow contracts for this treasury, bonds excluded. */
    committedAtomic: AtomicAmountSchema,
    orders: z.array(OpenEscrowSchema),
  }),
});
export type TreasuryResponseBody = z.infer<typeof TreasuryResponse>;

/** Funded and Revealed orders hold the buyer's USDC; a Created order exists onchain but nothing has moved. */
export const holdsFunds = (o: Pick<EscrowOrder, "status">): boolean => o.status === "Funded" || o.status === "Revealed";

export function treasuryRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();

  app.get("/", async (c) => {
    const open = await deps.repos.escrowOrders.listOpen();
    const funded = open.filter(holdsFunds);
    const committed = funded.reduce((sum, o) => sum + atomicToBigInt(o.amountAtomic), 0n);

    let chain: z.input<typeof ChainSnapshotSchema> | null = null;
    let chainUnavailable: string | undefined;
    try {
      const snapshot = await deps.ports.treasury.read();
      chain = {
        blockNumber: snapshot.blockNumber,
        balanceAtomic: snapshot.balanceAtomic,
        reservedTotalAtomic: snapshot.reservedTotalAtomic,
        usdc: snapshot.usdc,
        readAt: snapshot.readAt,
      };
    } catch (e) {
      if (!(e instanceof NotWiredError)) throw e;
      chainUnavailable = e.message;
    }

    return respond(c, TreasuryResponse, {
      treasury: deps.treasury,
      chain,
      ...(chainUnavailable !== undefined ? { chainUnavailable } : {}),
      escrow: {
        openOrders: open.length,
        fundedOrders: funded.length,
        committedAtomic: committed.toString(),
        orders: open.map((o) => ({
          purchaseId: o.purchaseId,
          escrowAddress: o.escrowAddress,
          status: o.status,
          amountAtomic: o.amountAtomic,
          funded: holdsFunds(o),
        })),
      },
    });
  });

  return app;
}
