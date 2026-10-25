import type { Repositories } from "@overflow/database";
import {
  isTerminalStatus,
  type ActivityEvent,
  type ActivityKind,
  type Address,
  type ChainTransaction,
  type Hex,
  type PurchaseRecord,
} from "@overflow/schemas";
import type { PurchaseService, TransitionSource } from "../orchestration/purchase-service.js";
import type { DecodedLog, JsonArgs } from "./decode.js";
import { completeControllerRequests } from "../exceptions/service.js";
import {
  isKnownEscrow,
  orderAmountForEscrow,
  purchaseForEscrow,
  purchaseForOrder as purchaseForOrderOn,
  waitingPurchaseForPayee,
} from "./lookup.js";

// ---------------------------------------------------------------------------
// One handler per indexed event. A handler runs inside the per-log database
// transaction after the chain_transactions row was inserted, and returns the
// activity events it wrote so the indexer can publish them after commit.
//
// Purchases and escrow orders move only through PurchaseService.transition.
// Authorization (Paid / Reserved), escrow funding (OrderFunded) and final
// settlement (PaidOut / Refunded) stay separate events; none implies another.
// ---------------------------------------------------------------------------

export interface HandlerContext {
  repos: Repositories;
  purchases: PurchaseService;
  row: ChainTransaction;
  decoded: DecodedLog;
  txHash: Hex;
  /** The treasury being indexed; tells a USDC Transfer's direction. */
  treasury: Address;
  /** Treasury owner from the deployments file; null when unknown. Only the owner's NodePaused completes a pause request. */
  owner: Address | null;
  /** Unix seconds of the log's block (fetched lazily; only KeyRevealed needs it). */
  blockTimestamp: () => Promise<bigint>;
  warn: (message: string) => void;
}

export interface HandlerResult {
  events: ActivityEvent[];
  purchaseId?: string | undefined;
  /** An escrow the indexer must start following (OrderCreated). */
  newEscrow?: Address | undefined;
}

const str = (args: JsonArgs, key: string): string => String(args[key] ?? "");
const addr = (args: JsonArgs, key: string): Address => str(args, key) as Address;
const hex = (args: JsonArgs, key: string): Hex => str(args, key) as Hex;

const source = (txHash: Hex): TransitionSource => ({ kind: "chain", reference: txHash });

const purchaseForOrder = (ctx: HandlerContext, orderId: string): Promise<PurchaseRecord | undefined> =>
  purchaseForOrderOn(ctx.repos, orderId);
/** Escrow events carry no orderId: the emitting contract is the order. */
const escrowOf = (ctx: HandlerContext): Address => ctx.row.contractAddress;
const purchaseForThisEscrow = (ctx: HandlerContext): Promise<PurchaseRecord | undefined> => purchaseForEscrow(ctx.repos, escrowOf(ctx));
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

async function link(ctx: HandlerContext, purchase: PurchaseRecord | undefined): Promise<void> {
  if (purchase && ctx.row.purchaseId !== purchase.id) await ctx.repos.chainTransactions.setPurchaseId(ctx.row.id, purchase.id);
}

async function note(
  ctx: HandlerContext,
  kind: ActivityKind,
  message: string,
  extra: { purchase?: PurchaseRecord | undefined; agentId?: string | undefined } = {},
): Promise<ActivityEvent> {
  return ctx.repos.activityEvents.insert({
    kind,
    message: `${message} [chain:${ctx.txHash}]`,
    txHash: ctx.txHash,
    ...(extra.purchase ? { purchaseId: extra.purchase.id, missionId: extra.purchase.missionId } : {}),
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
    simulated: false,
  });
}

/** Unmatched escrow events are still recorded, labeled as such, and never move anything. */
async function unmatched(ctx: HandlerContext, kind: ActivityKind, what: string): Promise<HandlerResult> {
  ctx.warn(`${ctx.decoded.eventName} from escrow ${escrowOf(ctx)} matches no purchase`);
  return { events: [await note(ctx, kind, `${what} from escrow ${escrowOf(ctx)} (no matching purchase)`)] };
}

const completed = (ctx: HandlerContext): Promise<ActivityEvent[]> =>
  completeControllerRequests(ctx.repos, { eventName: ctx.decoded.eventName, args: ctx.decoded.args, txHash: ctx.txHash, owner: ctx.owner });

type Handler = (ctx: HandlerContext) => Promise<HandlerResult>;

const handlers: Record<string, Handler> = {
  // ---- treasury -----------------------------------------------------------
  async NodeCreated(ctx) {
    const a = ctx.decoded.args;
    const key = addr(a, "key");
    const nodeId = Number(str(a, "id"));
    const agent = await ctx.repos.agents.getByKey(key);
    if (agent && agent.nodeId == null && Number.isSafeInteger(nodeId)) await ctx.repos.agents.setNodeId(agent.id, nodeId);
    const event = await note(
      ctx,
      "treasury.node",
      `NodeCreated: node ${str(a, "id")} under ${str(a, "parent")} for key ${key}, cap ${str(a, "cap")}, maxPerCall ${str(a, "maxPerCall")}, expiry ${str(a, "expiry")}` +
        (agent ? ` (agent ${agent.id})` : ""),
      { agentId: agent?.id },
    );
    return { events: [event] };
  },

  async Paid(ctx) {
    const a = ctx.decoded.args;
    const to = addr(a, "to");
    const purchase = await waitingPurchaseForPayee(ctx.repos, to);
    await link(ctx, purchase);
    const event = await note(
      ctx,
      "treasury.paid",
      `Paid: node ${str(a, "id")} paid ${str(a, "value")} atomic USDC to ${to}, nonce ${str(a, "nonce")}` +
        (purchase ? "" : " (no purchase is waiting on this payee)"),
      { purchase },
    );
    return { events: [event], purchaseId: purchase?.id };
  },

  async Reserved(ctx) {
    const a = ctx.decoded.args;
    const digest = hex(a, "digest");
    const purchase = await ctx.repos.purchases.getByAuthorizationDigest(digest);
    await link(ctx, purchase);
    if (!(await ctx.repos.reservations.getByDigest(digest))) {
      await ctx.repos.reservations.insert({
        digest,
        nodeId: Number(str(a, "id")),
        valueAtomic: str(a, "value"),
        validBefore: str(a, "validBefore"),
        nonce: hex(a, "nonce"),
        txHash: ctx.txHash,
        ...(purchase ? { purchaseId: purchase.id } : {}),
      });
    }
    const event = await note(
      ctx,
      "treasury.reserved",
      `Reserved: node ${str(a, "id")} reserved ${str(a, "value")} atomic USDC for ${str(a, "to")} until ${str(a, "validBefore")} (digest ${digest})`,
      { purchase },
    );
    return { events: [event], purchaseId: purchase?.id };
  },

  async ReservationReleased(ctx) {
    const a = ctx.decoded.args;
    const digest = hex(a, "digest");
    // `refunded`: USDC never consumed the nonce, so the charge was reversed up the ancestor chain (allowance restored).
    const budgetRestored = a["refunded"] === true;
    const reservation = await ctx.repos.reservations.getByDigest(digest);
    if (reservation && reservation.status === "active") await ctx.repos.reservations.markReleased(digest, ctx.txHash);
    const purchase = await ctx.repos.purchases.getByAuthorizationDigest(digest);
    await link(ctx, purchase);
    if (budgetRestored && purchase && purchase.status === "RESERVED") {
      // The reservation expired unused: USDC never moved, so the allowance came back.
      const r = await ctx.purchases.transition(purchase.id, "RELEASED", {
        reason: `ReservationReleased: reservation ${digest} expired unused; budget restored`,
        source: source(ctx.txHash),
        txHash: ctx.txHash,
      });
      return { events: [r.event], purchaseId: purchase.id };
    }
    const event = await note(
      ctx,
      "treasury.released",
      `ReservationReleased: reservation ${digest}` +
        (reservation ? ` (node ${reservation.nodeId}, ${reservation.valueAtomic} atomic USDC)` : "") +
        ` released; budget ${budgetRestored ? "restored (nonce unused)" : "kept (USDC had moved)"}`,
      { purchase },
    );
    return { events: [event], purchaseId: purchase?.id };
  },

  // Owner actions. Each may complete pending ControllerRequests: the stored event is the only thing that marks one done.
  async NodePaused(ctx) {
    const a = ctx.decoded.args;
    const event = await note(ctx, "treasury.node", `NodePaused: node ${str(a, "id")} paused by ${str(a, "by")}`);
    return { events: [event, ...(await completed(ctx))] };
  },
  async NodeUnpaused(ctx) {
    return { events: [await note(ctx, "treasury.node", `NodeUnpaused: node ${str(ctx.decoded.args, "id")} unpaused`)] };
  },
  async CapRaised(ctx) {
    const a = ctx.decoded.args;
    const event = await note(ctx, "treasury.node", `CapRaised: node ${str(a, "id")} cap ${str(a, "oldCap")} -> ${str(a, "newCap")}`);
    return { events: [event, ...(await completed(ctx))] };
  },
  async AllowSet(ctx) {
    const a = ctx.decoded.args;
    const event = await note(ctx, "treasury.policy", `AllowSet: payee ${str(a, "payee")} ${a["allowed"] === true ? "allowed" : "removed"}`);
    return { events: [event, ...(await completed(ctx))] };
  },
  async EscrowFactorySet(ctx) {
    return {
      events: [await note(ctx, "treasury.policy", `EscrowFactorySet: factory ${str(ctx.decoded.args, "factory")}`)],
    };
  },
  async ReservationWindowSet(ctx) {
    return {
      events: [await note(ctx, "treasury.policy", `ReservationWindowSet: reservations may live at most ${str(ctx.decoded.args, "secondsMax")} s`)],
    };
  },

  // ---- USDC ---------------------------------------------------------------
  /**
   * A USDC transfer into or out of the treasury. Funding and direct x402
   * purchases have no treasury event, so this is their only chain record; the
   * ledger books them from here (ledger/posting.ts). Transfers to or from an
   * escrow are booked by the escrow's own events and only noted.
   */
  async Transfer(ctx) {
    const a = ctx.decoded.args;
    const from = addr(a, "from");
    const to = addr(a, "to");
    const value = str(a, "value");
    const inflow = same(to, ctx.treasury);
    const counterparty = inflow ? from : to;
    const escrow = await isKnownEscrow(ctx.repos, counterparty);
    let purchase: PurchaseRecord | undefined;
    if (escrow) purchase = (await ctx.repos.purchases.listByEscrowAddress(counterparty)).find((p) => !isTerminalStatus(p.status));
    else if (!inflow) purchase = await waitingPurchaseForPayee(ctx.repos, to);
    await link(ctx, purchase);
    const what = inflow
      ? escrow
        ? "returned from escrow"
        : "treasury funded"
      : escrow
        ? "escrow funded"
        : purchase
          ? "direct x402 purchase"
          : "outflow matching no purchase";
    const event = await note(ctx, "usdc.transfer", `Transfer: ${value} atomic USDC from ${from} to ${to} (${what})`, { purchase });
    return { events: [event], purchaseId: purchase?.id };
  },

  // ---- factory ------------------------------------------------------------
  async OrderCreated(ctx) {
    const a = ctx.decoded.args;
    const orderId = hex(a, "orderId");
    const escrow = addr(a, "escrow");
    const seller = addr(a, "seller");
    const purchase = await purchaseForOrder(ctx, orderId);
    await link(ctx, purchase);
    // Seller history persists across missions: every order the factory opened counts.
    const resource = purchase ? await ctx.repos.resources.getById(purchase.resourceId) : undefined;
    await ctx.repos.sellerHistory.upsertIncrement(seller, { orders: 1, ...(resource ? { sellerId: resource.sellerId } : {}) });
    const event = await note(
      ctx,
      "escrow.created",
      `OrderCreated: escrow ${escrow} for order ${orderId}, buyer ${str(a, "buyer")}, seller ${seller}, amount ${str(a, "amount")}, termsHash ${str(a, "termsHash")}` +
        (purchase ? "" : " (no matching purchase)"),
      { purchase },
    );
    return { events: [event], purchaseId: purchase?.id, newEscrow: escrow };
  },

  /** The factory's cross-treasury cheat count went up (emitted inside the escrow's complaint transaction). */
  async CheatRecorded(ctx) {
    const a = ctx.decoded.args;
    const escrow = addr(a, "escrow");
    const purchase = await purchaseForEscrow(ctx.repos, escrow);
    await link(ctx, purchase);
    const event = await note(
      ctx,
      "seller.cheat-recorded",
      `CheatRecorded: factory counted a proven cheat for seller ${str(a, "seller")} on escrow ${escrow}; the treasury now reverts PayeeFlagged for this seller`,
      { purchase },
    );
    return { events: [event], purchaseId: purchase?.id };
  },

  // ---- escrow (the emitting address is the order) ---------------------------
  async OrderFunded(ctx) {
    const a = ctx.decoded.args;
    const purchase = await purchaseForThisEscrow(ctx);
    if (!purchase) return unmatched(ctx, "escrow.funded", `OrderFunded (balance ${str(a, "balance")} atomic USDC)`);
    await link(ctx, purchase);
    const r = await ctx.purchases.transition(purchase.id, "ESCROW_FUNDED", {
      reason: `OrderFunded: escrow ${escrowOf(ctx)} holds ${str(a, "balance")} atomic USDC (price plus the seller's bond)`,
      // The indexer confirming an earlier uncertain broadcast is the reconciliation against the chain.
      source: purchase.status === "PAYMENT_UNKNOWN" ? { kind: "reconciliation", reference: ctx.txHash } : source(ctx.txHash),
      txHash: ctx.txHash,
      escrow: { status: "Funded" },
    });
    if (!r.escrow) ctx.warn(`purchase ${purchase.id} has no escrow_orders row; OrderFunded recorded on the purchase only`);
    return { events: [r.event], purchaseId: purchase.id };
  },

  async KeyRevealed(ctx) {
    const a = ctx.decoded.args;
    const purchase = await purchaseForThisEscrow(ctx);
    if (!purchase) return unmatched(ctx, "escrow.revealed", "KeyRevealed");
    await link(ctx, purchase);
    const challengeEnd = str(a, "challengeEnd");
    const r = await ctx.purchases.transition(purchase.id, "DELIVERY_PENDING", {
      reason: `KeyRevealed: seller revealed the delivery key for escrow ${escrowOf(ctx)}; challenge window open until ${challengeEnd}`,
      source: source(ctx.txHash),
      txHash: ctx.txHash,
      escrow: { status: "Revealed", revealedKey: hex(a, "key"), challengeEnd },
    });
    if (r.escrow) {
      // revealKey() requires block.timestamp < revealDeadline, so an indexed reveal is on time by construction;
      // the block timestamp is still checked so a wrong deadline on the stored order shows up as "late".
      const ts = await ctx.blockTimestamp();
      const onTime = ts < BigInt(r.escrow.revealDeadline);
      await ctx.repos.sellerHistory.upsertIncrement(purchase.sellerAddress, onTime ? { onTimeReveals: 1 } : { lateReveals: 1 });
    } else {
      ctx.warn(`purchase ${purchase.id} has no escrow_orders row; reveal timing not scored`);
    }
    return { events: [r.event], purchaseId: purchase.id };
  },

  async Accepted(ctx) {
    const a = ctx.decoded.args;
    const purchase = await purchaseForThisEscrow(ctx);
    await link(ctx, purchase);
    const event = await note(
      ctx,
      "escrow.accepted",
      `Accepted: treasury node ${str(a, "nodeId")} (key ${str(a, "signer")}) accepted delivery from escrow ${escrowOf(ctx)}`,
      { purchase },
    );
    return { events: [event], purchaseId: purchase?.id };
  },

  async PaidOut(ctx) {
    const a = ctx.decoded.args;
    const purchase = await purchaseForThisEscrow(ctx);
    if (!purchase) return unmatched(ctx, "escrow.settled", `PaidOut ${str(a, "amount")} atomic USDC (bond ${str(a, "bond")}) to ${str(a, "seller")}`);
    await link(ctx, purchase);
    const r = await ctx.purchases.transition(purchase.id, "SETTLED", {
      reason: `PaidOut: ${str(a, "amount")} atomic USDC paid to seller ${str(a, "seller")} (bond ${str(a, "bond")} returned)`,
      source: source(ctx.txHash),
      txHash: ctx.txHash,
      escrow: { status: "Settled" },
    });
    return { events: [r.event], purchaseId: purchase.id };
  },

  async Refunded(ctx) {
    const a = ctx.decoded.args;
    const reason = str(a, "reason") || "unspecified";
    const purchase = await purchaseForThisEscrow(ctx);
    if (!purchase) return unmatched(ctx, "escrow.refunded", `Refunded (${reason})`);
    await link(ctx, purchase);
    const held = await orderAmountForEscrow(ctx.repos, escrowOf(ctx));
    const amounts = held ? `${held.amount} atomic USDC price plus ${held.bond} bond` : "the escrow's whole balance";
    // A refund restores treasury USDC. It never restores the agent's spent allowance.
    const r = await ctx.purchases.transition(purchase.id, "REFUNDED", {
      reason: `Refunded: ${amounts} returned to the treasury (${reason}); allowance unchanged`,
      source: source(ctx.txHash),
      txHash: ctx.txHash,
      escrow: { status: "Refunded", refundReason: reason },
    });
    return { events: [r.event], purchaseId: purchase.id };
  },

  async CheatProven(ctx) {
    const a = ctx.decoded.args;
    const seller = addr(a, "seller");
    const purchase = await purchaseForThisEscrow(ctx);
    await link(ctx, purchase);
    await ctx.repos.sellerHistory.upsertIncrement(seller, { provenCheats: 1, flagged: true });
    // The stored complaint (if the buyer built one here) is proven only by this event.
    const complaint = await ctx.repos.complaints.markProven(escrowOf(ctx), ctx.txHash);
    const event = await note(
      ctx,
      "seller.flagged",
      `CheatProven: seller ${seller} cheated on chunk ${str(a, "index")} of escrow ${escrowOf(ctx)}; flagged for every treasury` +
        (complaint ? ` (complaint ${complaint.id} proven)` : ""),
      { purchase },
    );
    return { events: [event], purchaseId: purchase?.id };
  },

  /** USDC that reached a closed order came back to the buyer treasury. Booked by reconciliation/sweeps; noted here. */
  async Swept(ctx) {
    const a = ctx.decoded.args;
    const purchase = await purchaseForThisEscrow(ctx);
    await link(ctx, purchase);
    const event = await note(
      ctx,
      "escrow.swept",
      `Swept: ${str(a, "amount")} atomic USDC returned from closed escrow ${escrowOf(ctx)} to ${str(a, "buyer")}`,
      { purchase },
    );
    return { events: [event], purchaseId: purchase?.id };
  },
};

export function handlerFor(eventName: string): Handler | undefined {
  return handlers[eventName];
}
