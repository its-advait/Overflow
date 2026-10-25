import type { BehaviorStore } from "./behavior.js";
import type { RecourseChain, TxOutcome } from "./chain.js";
import type { OrderActionKind, OrderRecord, OrderStore } from "./orders.js";
import type { SellerBehavior } from "./protocol.js";
import { LOG_PREFIX } from "./routes.js";

// ---------------------------------------------------------------------------
// Background worker of the SIMULATED Recourse sellers: polls each open order's
// escrow status and performs the seller's next contract call (bond transfer,
// markFunded, revealKey, finalizePayout) according to the seller's CURRENT
// behavior. Every write is recorded with its hash and status; an `unknown`
// outcome is recorded and never resent (the next tick re-reads the chain).
// ---------------------------------------------------------------------------

export interface CreateRecourseWorkerOptions {
  store: OrderStore;
  sellers: Map<string, { chain: RecourseChain }>;
  behaviors: BehaviorStore;
  intervalMs?: number | undefined;
  /** Unix seconds. */
  now: () => bigint;
  log?: ((line: string) => void) | undefined;
}

export interface RecourseWorker {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  status(): string;
}

/** Seconds of margin before revealDeadline (blocks every ~2 s; the local clock may run ahead). */
export const REVEAL_MARGIN_S = 5n;
/** Seconds past challengeEnd before finalizePayout (block.timestamp must be >= challengeEnd). */
export const FINALIZE_MARGIN_S = 2n;

export function createRecourseWorker(opts: CreateRecourseWorkerOptions): RecourseWorker {
  const { store, sellers, behaviors, now } = opts;
  const log = opts.log ?? ((line: string) => console.log(`${LOG_PREFIX} worker: ${line}`));
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let ticks = 0;
  let lastError: string | null = null;

  const hasUnknown = (o: OrderRecord, kind: OrderActionKind) => o.actions.some((a) => a.kind === kind && a.status === "unknown");

  const record = (o: OrderRecord, kind: OrderActionKind, behavior: SellerBehavior, outcome: TxOutcome) => {
    o.actions.push({
      kind,
      behavior,
      status: outcome.status,
      ...(outcome.status !== "simulation-reverted" ? { txHash: outcome.hash } : {}),
      ...("error" in outcome ? { error: outcome.error } : {}),
      at: new Date().toISOString(),
    });
    const hash = outcome.status === "simulation-reverted" ? "(not sent)" : outcome.hash;
    log(`${o.orderId.slice(0, 10)} ${kind} [${behavior}] ${outcome.status} ${hash}${"error" in outcome ? `: ${outcome.error}` : ""}`);
    if (outcome.status === "unknown") store.noteOnce(o.orderId, `${kind}: outcome unknown for tx ${outcome.hash}; not retried, the next tick re-reads the escrow status`);
  };

  const note = (o: OrderRecord, text: string) => {
    if (store.noteOnce(o.orderId, text)) log(`${o.orderId.slice(0, 10)} ${text}`);
  };

  const onCreated = async (o: OrderRecord, chain: RecourseChain, behavior: SellerBehavior) => {
    const amount = BigInt(o.terms.amount);
    const bond = BigInt(o.terms.bond);
    if (bond > 0n && !o.bondSent) {
      const outcome = await chain.transferUsdc(o.escrowAddress, bond);
      if (outcome.status === "simulation-reverted") {
        note(o, `bond ${bond} USDC atomic: transfer simulation reverted (seller ${o.sellerAddress} lacks USDC?); waiting: ${outcome.error}`);
        return;
      }
      record(o, "bond", behavior, outcome);
      if (outcome.status === "success" || outcome.status === "unknown") o.bondSent = true;
      if (outcome.status !== "success") return;
    }
    if (hasUnknown(o, "markFunded")) return;
    const balance = await chain.usdcBalance(o.escrowAddress);
    if (balance >= amount + bond) {
      record(o, "markFunded", behavior, await chain.markFunded(o.escrowAddress));
    }
  };

  const onFunded = async (o: OrderRecord, chain: RecourseChain, behavior: SellerBehavior) => {
    if (behavior === "ghost") {
      note(o, `ghost: never reveals; the buyer may claimTimeoutRefund after ${o.terms.revealDeadline}`);
      return;
    }
    if (hasUnknown(o, "revealKey")) return;
    const deadline = BigInt(o.terms.revealDeadline);
    if (now() < deadline - REVEAL_MARGIN_S) {
      record(o, "revealKey", behavior, await chain.revealKey(o.escrowAddress, o.k));
    } else {
      note(o, `reveal window passed (deadline ${deadline}); not revealing, the buyer may claimTimeoutRefund`);
    }
  };

  const onRevealed = async (o: OrderRecord, chain: RecourseChain, behavior: SellerBehavior) => {
    if (hasUnknown(o, "finalizePayout")) return;
    const end = await chain.challengeEnd(o.escrowAddress);
    if (end > 0n && now() >= end + FINALIZE_MARGIN_S) {
      record(o, "finalizePayout", behavior, await chain.finalizePayout(o.escrowAddress));
    }
  };

  const tick = async () => {
    if (running) return;
    running = true;
    ticks++;
    try {
      for (const o of store.listOpen()) {
        const chain = sellers.get(o.sellerId)?.chain;
        if (!chain) {
          note(o, `no chain for seller ${o.sellerId}; skipping`);
          continue;
        }
        try {
          const status = await chain.status(o.escrowAddress);
          o.lastStatus = status;
          const behavior = behaviors.get(o.sellerId) ?? "honest";
          switch (status) {
            case "Created":
              await onCreated(o, chain, behavior);
              break;
            case "Funded":
              await onFunded(o, chain, behavior);
              break;
            case "Revealed":
              await onRevealed(o, chain, behavior);
              break;
            case "Settled":
            case "Refunded":
              o.closed = true;
              log(`${o.orderId.slice(0, 10)} ${status}: closed`);
              break;
          }
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          log(`${o.orderId.slice(0, 10)} tick error: ${lastError}`);
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), opts.intervalMs ?? 5000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status: () => `${timer ? "running" : "stopped"}, ${ticks} tick(s), ${store.listOpen().length} open order(s)${lastError ? `, last error: ${lastError}` : ""}`,
  };
}
