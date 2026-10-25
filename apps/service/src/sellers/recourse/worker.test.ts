import type { Hex } from "@overflow/schemas";
import { beforeAll, describe, expect, it } from "vitest";
import { createBehaviorStore } from "./behavior.js";
import { createFakeRecourseChain } from "./chain.test-util.js";
import type { RecourseListing } from "./datasets.js";
import { BUYER, loadSmallListing, SALT, SELLER, SELLER_SECRET } from "./fixtures.test-util.js";
import { createOrderStore, type OrderRecord } from "./orders.js";
import type { SellerBehavior } from "./protocol.js";
import { buildOrder } from "./terms.js";
import { createRecourseWorker } from "./worker.js";

let listing: RecourseListing;
beforeAll(async () => {
  listing = await loadSmallListing();
});

async function harness(behavior: SellerBehavior, opts: { sellerUsdc?: bigint; salt?: Hex } = {}) {
  let now = 1_800_000_000n;
  const clock = { now: () => now, advance: (s: bigint) => (now += s) };
  const chain = createFakeRecourseChain({ sellerAddress: SELLER.address, usdcBalances: { [SELLER.address]: opts.sellerUsdc ?? 1_000_000_000n }, now: clock.now });
  const behaviors = createBehaviorStore(new Map([["sim-seller-a", behavior]]));
  const store = createOrderStore();
  const built = buildOrder({ listing, buyer: BUYER, missionId: "m-1", seller: SELLER.address, sellerSecret: SELLER_SECRET, salt: opts.salt ?? SALT, nowSeconds: now, config: { bondBps: 2000, revealWindowS: 600, challengeWindowS: 120 }, behavior });
  const escrow = await chain.predict(built.terms.orderId, built.terms.termsHash);
  const created = await chain.create(built.terms);
  if (created.status !== "success") throw new Error("fake create failed");
  const order: OrderRecord = {
    orderId: built.terms.orderId, listingId: listing.id, sellerId: "sim-seller-a", sellerAddress: SELLER.address, buyer: BUYER, missionId: "m-1", salt: SALT, terms: built.terms,
    escrowAddress: escrow, createTxHash: created.hash, k: built.k, cipherChunks: built.cipherChunks, plainLeaves: listing.plainLeaves, swapIndex: built.swapIndex, behaviorAtCreate: behavior,
    createdAt: new Date().toISOString(), actions: [], lastStatus: null, bondSent: false, notes: [], closed: false,
  };
  store.insert(order);
  const worker = createRecourseWorker({ store, sellers: new Map([["sim-seller-a", { chain }]]), behaviors, now: clock.now, log: () => {} });
  const amount = BigInt(built.terms.amount);
  const bond = BigInt(built.terms.bond);
  return { chain, behaviors, store, order, worker, clock, escrow, amount, bond, k: built.k };
}

describe("SIMULATED Recourse seller worker", () => {
  it("honest: bond -> markFunded after the buyer pays -> revealKey -> finalizePayout after the challenge window", async () => {
    const h = await harness("honest");
    await h.worker.tick();
    expect(h.order.bondSent).toBe(true);
    expect(await h.chain.usdcBalance(h.escrow)).toBe(h.bond);
    expect(h.order.lastStatus).toBe("Created");
    expect(h.order.actions.map((a) => a.kind)).toEqual(["bond"]);

    await h.worker.tick(); // buyer has not paid: nothing to do
    expect(h.order.actions).toHaveLength(1);

    h.chain.fundEscrow(h.escrow, h.amount);
    await h.worker.tick();
    expect(h.order.actions.map((a) => a.kind)).toEqual(["bond", "markFunded"]);
    expect(await h.chain.status(h.escrow)).toBe("Funded");

    await h.worker.tick();
    expect(h.order.actions.at(-1)).toMatchObject({ kind: "revealKey", behavior: "honest", status: "success" });
    expect(h.chain.escrows.get(h.escrow)!.revealedKey).toBe(h.k);
    expect(await h.chain.status(h.escrow)).toBe("Revealed");

    await h.worker.tick(); // challenge window open
    expect(h.order.actions).toHaveLength(3);
    h.clock.advance(125n);
    await h.worker.tick();
    expect(h.order.actions.at(-1)).toMatchObject({ kind: "finalizePayout", status: "success" });
    expect(await h.chain.status(h.escrow)).toBe("Settled");
    expect(h.order.closed).toBe(false);
    await h.worker.tick();
    expect(h.order.closed).toBe(true);
    expect(h.order.lastStatus).toBe("Settled");
    expect(h.order.actions.every((a) => a.txHash)).toBe(true);
    expect(await h.chain.usdcBalance(SELLER.address)).toBe(1_000_000_000n + h.amount);
  });

  it("ghost: marks funded but never reveals; the buyer's timeout refund closes it", async () => {
    const h = await harness("ghost");
    h.chain.fundEscrow(h.escrow, h.amount);
    await h.worker.tick();
    await h.worker.tick();
    expect(await h.chain.status(h.escrow)).toBe("Funded");
    for (let i = 0; i < 10; i++) await h.worker.tick();
    expect(h.chain.calls.filter((c) => c.fn === "revealKey")).toHaveLength(0);
    expect(h.order.notes.filter((n) => n.startsWith("ghost:"))).toHaveLength(1);
    h.clock.advance(601n);
    h.chain.claimTimeoutRefund(h.escrow);
    await h.worker.tick();
    expect(h.order.closed).toBe(true);
    expect(h.order.lastStatus).toBe("Refunded");
  });

  it("swap: reveals the true key k (the commitment is honest; the ciphertext is not)", async () => {
    const h = await harness("swap");
    h.chain.fundEscrow(h.escrow, h.amount);
    await h.worker.tick();
    await h.worker.tick();
    await h.worker.tick();
    expect(await h.chain.status(h.escrow)).toBe("Revealed");
    expect(h.chain.escrows.get(h.escrow)!.revealedKey).toBe(h.k);
    expect(h.order.swapIndex).not.toBeNull();
    expect(h.order.actions.at(-1)).toMatchObject({ kind: "revealKey", behavior: "swap" });
  });

  it("flipping behavior to ghost after funding stops the reveal (behavior is read at tick time)", async () => {
    const h = await harness("honest");
    h.chain.fundEscrow(h.escrow, h.amount);
    await h.worker.tick(); // bond + markFunded in one tick (the buyer already paid); the reveal would be the next tick
    expect(await h.chain.status(h.escrow)).toBe("Funded");
    h.behaviors.set("sim-seller-a", "ghost");
    for (let i = 0; i < 5; i++) await h.worker.tick();
    expect(await h.chain.status(h.escrow)).toBe("Funded");
    expect(h.chain.calls.filter((c) => c.fn === "revealKey")).toHaveLength(0);
  });

  it("seller without USDC notes the bond failure once and keeps waiting", async () => {
    const h = await harness("honest", { sellerUsdc: 0n });
    await h.worker.tick();
    await h.worker.tick();
    await h.worker.tick();
    expect(h.order.bondSent).toBe(false);
    expect(h.order.actions).toHaveLength(0);
    expect(h.order.notes.filter((n) => n.includes("simulation reverted"))).toHaveLength(1);
    expect(h.chain.calls.filter((c) => c.fn === "transferUsdc")).toHaveLength(3); // simulated only; nothing was sent
  });

  it("an unknown outcome records the hash and is never resent; the next tick moves on once the chain shows it landed", async () => {
    const h = await harness("honest");
    h.chain.forceNext("transferUsdc", { status: "unknown", apply: true });
    await h.worker.tick();
    expect(h.order.bondSent).toBe(true);
    expect(h.order.actions[0]).toMatchObject({ kind: "bond", status: "unknown" });
    expect(h.order.actions[0]!.txHash).toBeDefined();
    h.chain.fundEscrow(h.escrow, h.amount);
    await h.worker.tick();
    expect(h.chain.calls.filter((c) => c.fn === "transferUsdc")).toHaveLength(1);
    expect(await h.chain.status(h.escrow)).toBe("Funded");

    h.chain.forceNext("revealKey", { status: "unknown", apply: false });
    await h.worker.tick();
    expect(h.order.actions.at(-1)).toMatchObject({ kind: "revealKey", status: "unknown" });
    for (let i = 0; i < 5; i++) await h.worker.tick();
    expect(h.chain.calls.filter((c) => c.fn === "revealKey")).toHaveLength(1);
    expect(await h.chain.status(h.escrow)).toBe("Funded");
    expect(h.order.notes.some((n) => n.startsWith("revealKey: outcome unknown"))).toBe(true);
  });
});
