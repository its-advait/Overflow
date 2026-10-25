import type { Repositories } from "@overflow/database";
import {
  AddressSchema,
  EscrowActionsSchema,
  EscrowDetailResponseSchema,
  EscrowListResponseSchema,
  IdSchema,
  type ComplaintRecord,
  type EscrowChainState,
  type EscrowOrder,
  type EscrowSummary,
  type PurchaseRecord,
  type ResourceRecord,
} from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import { escrowForAddress } from "../../chain/lookup.js";
import { computeEscrowActions } from "../../recourse/actions.js";
import type { ApiDeps } from "../deps.js";
import { ApiError, parseParams, respond, type ApiEnv } from "../http.js";
import { NotWiredError } from "../ports.js";
import { loadPurchase } from "./purchases.js";

// ---------------------------------------------------------------------------
// GET /api/escrow            every escrow order with its purchase and resource label
// GET /api/escrow/:id        one order: stored terms + chain events + sample + complaint + live chain state + gates
// GET /api/escrow/:id/actions the gates alone (501 when the service has no chain reader)
//
// `:id` is a purchase id or an escrow address. Status in `escrow` mirrors confirmed chain events (the indexer);
// `chain` is a fresh eth_call at one block; `actions` are judged at that block's timestamp. The API never sends
// a transaction: the gates say what the contract would accept, nothing more.
// ---------------------------------------------------------------------------

const IdParams = z.object({ id: IdSchema });
const ActionsResponse = z.object({ actions: EscrowActionsSchema, escrowAddress: AddressSchema });

const resourceLabel = (r: ResourceRecord | undefined) => (r ? { id: r.id, title: r.title, sellerId: r.sellerId, simulated: r.simulated } : null);

async function findEscrow(repos: Repositories, id: string): Promise<EscrowOrder> {
  const byAddress = AddressSchema.safeParse(id);
  const escrow = byAddress.success ? await escrowForAddress(repos, byAddress.data) : await repos.escrowOrders.getByPurchase(id);
  if (!escrow) throw new ApiError(404, "not_found", `escrow ${id} not found`);
  return escrow;
}

type ChainRead =
  | { chain: EscrowChainState; actions: ReturnType<typeof computeEscrowActions> }
  | { chain: null; actions: null; unavailable: string; notWired: NotWiredError | undefined };

/** One eth_call round trip; a missing or failing reader degrades to "unavailable" so stored evidence still renders. */
async function readChain(deps: ApiDeps, escrow: EscrowOrder, complaint: ComplaintRecord | undefined): Promise<ChainRead> {
  try {
    const [latest, state] = await Promise.all([deps.ports.escrowRead.latest(), deps.ports.escrowRead.state(escrow.escrowAddress)]);
    const chain: EscrowChainState = {
      status: state.status,
      challengeEnd: state.challengeEnd.toString(),
      revealedKey: state.revealedKey,
      balanceAtomic: state.balance.toString(),
      blockNumber: latest.blockNumber.toString(),
      blockTimestamp: latest.blockTimestamp.toString(),
    };
    const actions = computeEscrowActions({
      status: state.status,
      revealDeadline: BigInt(escrow.revealDeadline),
      challengeEnd: state.challengeEnd,
      balance: state.balance,
      now: latest.blockTimestamp,
      complaintReady: Boolean(complaint && complaint.cipherProofVerified && complaint.plainProofVerified && complaint.cheatVerified),
    });
    return { chain, actions };
  } catch (e) {
    if (e instanceof NotWiredError) return { chain: null, actions: null, unavailable: e.message, notWired: e };
    return { chain: null, actions: null, unavailable: `chain read failed: ${e instanceof Error ? e.message : String(e)}`, notWired: undefined };
  }
}

export function escrowRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();

  app.get("/", async (c) => {
    const orgId = c.get("session").organizationId;
    const escrows: EscrowSummary[] = [];
    for (const escrow of await deps.repos.escrowOrders.listAll()) {
      const purchase = await deps.repos.purchases.getById(escrow.purchaseId);
      if (!purchase) continue;
      const mission = await deps.repos.missions.getById(purchase.missionId);
      if (!mission || mission.organizationId !== orgId) continue;
      const resource = await deps.repos.resources.getById(purchase.resourceId);
      const complaint = await deps.repos.complaints.getByPurchase(purchase.id);
      const sample = (await deps.repos.samples.listByPurchase(purchase.id)).at(-1);
      escrows.push({
        id: escrow.id,
        purchaseId: purchase.id,
        escrowAddress: escrow.escrowAddress,
        sellerAddress: escrow.sellerAddress,
        amountAtomic: escrow.amountAtomic,
        bondAtomic: escrow.bondAtomic,
        status: escrow.status,
        ...(escrow.refundReason ? { refundReason: escrow.refundReason } : {}),
        purchaseStatus: purchase.status,
        resource: resourceLabel(resource),
        ...(complaint ? { complaint: complaint.status } : {}),
        simulated: Boolean(resource?.simulated || sample?.simulated || complaint?.simulated),
        createdAt: escrow.createdAt,
        updatedAt: escrow.updatedAt,
      });
    }
    return respond(c, EscrowListResponseSchema, { escrows });
  });

  app.get("/:id", async (c) => {
    const { id } = parseParams(c, IdParams);
    const escrow = await findEscrow(deps.repos, id);
    const purchase: PurchaseRecord = await loadPurchase(deps, c.get("session").organizationId, escrow.purchaseId);
    const [resource, chainTransactions, samples, complaint, activity] = await Promise.all([
      deps.repos.resources.getById(purchase.resourceId),
      deps.repos.chainTransactions.listByPurchase(purchase.id),
      deps.repos.samples.listByPurchase(purchase.id),
      deps.repos.complaints.getByPurchase(purchase.id),
      deps.repos.activityEvents.listByPurchase(purchase.id),
    ]);
    const sample = samples.at(-1) ?? null;
    const read = await readChain(deps, escrow, complaint);
    return respond(c, EscrowDetailResponseSchema, {
      escrow,
      purchase,
      resource: resourceLabel(resource),
      chain: read.chain,
      ...(read.chain === null ? { chainUnavailable: read.unavailable } : {}),
      chainTransactions,
      sample,
      complaint: complaint ?? null,
      actions: read.actions,
      activity,
      simulated: Boolean(resource?.simulated || sample?.simulated || complaint?.simulated),
    });
  });

  app.get("/:id/actions", async (c) => {
    const { id } = parseParams(c, IdParams);
    const escrow = await findEscrow(deps.repos, id);
    await loadPurchase(deps, c.get("session").organizationId, escrow.purchaseId);
    const complaint = await deps.repos.complaints.getByPurchase(escrow.purchaseId);
    const read = await readChain(deps, escrow, complaint);
    if (read.chain === null) {
      if (read.notWired) throw read.notWired;
      throw new ApiError(503, "chain_unavailable", read.unavailable);
    }
    return respond(c, ActionsResponse, { actions: read.actions, escrowAddress: escrow.escrowAddress });
  });

  return app;
}
