import { AddressSchema, NetworkInfoSchema, RecourseSellerViewSchema, RunOrderBodySchema, RunOrderResponseSchema, SellersResponseSchema, SetSellerBehaviourBodySchema } from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { parseBody, parseParams, respond, type ApiEnv } from "../http.js";

// ---------------------------------------------------------------------------
// Judge controls (docs/SPEC.md "A judge's own scenario"), all over SIMULATED
// parties on the local Anvil fork:
//   GET  /api/settings/sellers            each SIMULATED seller and the behaviour it plays next
//   PUT  /api/settings/sellers/:address   change that behaviour (in memory; a restart resets it)
//   POST /api/settings/orders             run ONE order now with the seller's current behaviour
//   GET  /api/settings/network            chain, treasury, factory, owner, token, floor, window
// Every write here is a proposal to the runner, which pays through settle()
// like any agent; the chain and the indexer decide what happened. The response
// of POST /orders is the runner's log, not a status: read GET /api/escrow/:id.
// ---------------------------------------------------------------------------

const AddressParams = z.object({ address: AddressSchema });
const SellerResponse = z.object({ seller: RecourseSellerViewSchema });
const SELLERS_NOTE = "SIMULATED sellers of the local Anvil recourse run. The behaviour applies to the seller's next order and lives in memory: a service restart returns to the defaults (honest, ghost, swap by key order).";
const ORDER_NOTE = "SIMULATED order on the local Anvil fork. lastStep is what the runner did; the purchase and escrow statuses come from the indexer: read GET /api/escrow/:purchaseId.";

export function settingsRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();

  app.get("/sellers", async (c) => {
    const sellers = await deps.ports.recourse.sellers();
    return respond(c, SellersResponseSchema, { sellers, simulated: true, note: SELLERS_NOTE });
  });

  app.put("/sellers/:address", async (c) => {
    const { address } = parseParams(c, AddressParams);
    const { behaviour } = await parseBody(c, SetSellerBehaviourBodySchema);
    const seller = await deps.ports.recourse.setBehaviour(address, behaviour);
    return respond(c, SellerResponse, { seller });
  });

  app.post("/orders", async (c) => {
    const body = await parseBody(c, RunOrderBodySchema);
    const order = await deps.ports.recourse.runOrder({
      sellerAddress: body.sellerAddress,
      listingId: body.listingId,
      ...(body.bondAtomic !== undefined ? { bondAtomic: BigInt(body.bondAtomic) } : {}),
    });
    return respond(c, RunOrderResponseSchema, { order, simulated: true, note: ORDER_NOTE });
  });

  app.get("/network", async (c) => {
    const info = await deps.ports.network.read();
    return respond(c, NetworkInfoSchema, info);
  });

  return app;
}
