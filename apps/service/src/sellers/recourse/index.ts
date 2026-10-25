/**
 * SIMULATED Recourse sellers: escrow-backed dataset delivery (docs/SPEC.md).
 * Nothing here moves USDC except through OverflowEscrow/OverflowEscrowFactory;
 * the seller only commits terms, posts its bond, reveals its key and asks for
 * payout, and the buyer side verifies every step against the chain.
 */
import type { Address } from "@overflow/schemas";
import type { Facilitator } from "../../facilitator/settle.js";
import { createBehaviorStore } from "./behavior.js";
import type { RecourseChain } from "./chain.js";
import type { RecourseConfig } from "./config.js";
import type { RecourseListing } from "./datasets.js";
import { createOrderStore } from "./orders.js";
import { createRecourseRoutes, type RecourseSellerRuntime } from "./routes.js";
import { createRecourseWorker } from "./worker.js";

export * from "./behavior.js";
export * from "./chain.js";
export * from "./config.js";
export * from "./datasets.js";
export * from "./orders.js";
export * from "./protocol.js";
export * from "./routes.js";
export * from "./terms.js";
export * from "./worker.js";

export interface CreateRecourseSellersOptions {
  config: RecourseConfig;
  listings: Map<string, RecourseListing>;
  /** One RecourseChain (one relayer, one nonce manager) per DISTINCT seller address. */
  chainFor: (sellerAddress: Address) => RecourseChain;
  facilitator: Facilitator | null;
  facilitatorUnavailableReason?: string | undefined;
  sellerUrl: string;
  allowForceBroadcast: boolean;
  intervalMs?: number | undefined;
  now?: (() => bigint) | undefined;
  log?: ((line: string) => void) | undefined;
}

export function createRecourseSellers(opts: CreateRecourseSellersOptions) {
  const { config } = opts;
  const chains = new Map<string, RecourseChain>();
  const sellers = new Map<string, RecourseSellerRuntime>();
  for (const s of config.sellers.values()) {
    const address = s.account.address;
    let chain = chains.get(address.toLowerCase());
    if (!chain) {
      chain = opts.chainFor(address);
      chains.set(address.toLowerCase(), chain);
    }
    sellers.set(s.sellerId, { sellerId: s.sellerId, address, sellerSecret: s.sellerSecret, chain });
  }
  const behaviors = createBehaviorStore(config.behaviors);
  const store = createOrderStore();
  const now = opts.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const routes = createRecourseRoutes({
    listings: opts.listings,
    sellers,
    behaviors,
    store,
    sellerUrl: opts.sellerUrl,
    facilitator: opts.facilitator,
    facilitatorUnavailableReason: opts.facilitatorUnavailableReason,
    allowForceBroadcast: opts.allowForceBroadcast,
    config: { bondBps: config.bondBps, revealWindowS: config.revealWindowS, challengeWindowS: config.challengeWindowS, swapIndex: config.swapIndex },
    now,
    log: opts.log,
  });
  const worker = createRecourseWorker({ store, sellers, behaviors, intervalMs: opts.intervalMs, now, log: opts.log });

  const summary = () => ({
    simulated: true as const,
    enabled: true,
    sellers: [...sellers.values()].map((s) => ({
      sellerId: s.sellerId,
      sellerAddress: s.address,
      behavior: behaviors.get(s.sellerId) ?? "honest",
      listings: [...opts.listings.values()].filter((l) => l.sellerId === s.sellerId).map((l) => l.id),
    })),
    bondBps: config.bondBps,
    revealWindowS: config.revealWindowS,
    challengeWindowS: config.challengeWindowS,
    orders: { open: store.listOpen().length, total: store.listAll().length },
    worker: worker.status(),
    routes: ["/sellers", "/sellers/:id/behavior", "/orders", "/orders/:id", "/orders/:id/cipher", "/orders/:id/sample", "/r/:resourceId", "/r/:resourceId/manifest"],
  });

  const status = () =>
    `SIMULATED Recourse sellers: ${[...sellers.values()].map((s) => `${s.sellerId}=${behaviors.get(s.sellerId) ?? "honest"}@${s.address.slice(0, 8)}`).join(", ")}; ${chains.size} chain(s); ${opts.listings.size} listing(s); bond ${config.bondBps} bps; reveal ${config.revealWindowS}s; challenge ${config.challengeWindowS}s`;

  return { routes, worker, store, behaviors, sellers, summary, status };
}
