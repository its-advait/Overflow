import { AddressSchema, ChainTransactionSchema, EscrowOrderSchema, IdSchema } from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { ApiError, parseParams, respond, type ApiEnv } from "../http.js";
import { loadPurchase } from "./purchases.js";

const IdParams = z.object({ id: IdSchema });
const Response = z.object({ escrow: EscrowOrderSchema, chainTransactions: z.array(ChainTransactionSchema) });

/** `:id` is a purchase id or an escrow address. Status mirrors confirmed chain events only. */
export function escrowRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();
  app.get("/:id", async (c) => {
    const { id } = parseParams(c, IdParams);
    const byAddress = AddressSchema.safeParse(id);
    const escrow = byAddress.success
      ? await deps.repos.escrowOrders.getByAddress(byAddress.data)
      : await deps.repos.escrowOrders.getByPurchase(id);
    if (!escrow) throw new ApiError(404, "not_found", `escrow ${id} not found`);
    await loadPurchase(deps, c.get("session").organizationId, escrow.purchaseId);
    const chainTransactions = await deps.repos.chainTransactions.listByPurchase(escrow.purchaseId);
    return respond(c, Response, { escrow, chainTransactions });
  });
  return app;
}
