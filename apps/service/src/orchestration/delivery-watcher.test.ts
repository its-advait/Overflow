import type { Repositories } from "@overflow/database";
import { acceptDigest } from "@overflow/payment-client";
import { hashLeaf, verifyProof } from "@overflow/recourse-crypto";
import { overflowEscrowAbi, USDC, type Address, type Hex } from "@overflow/schemas";
import { decodeFunctionData, getAddress, recoverAddress, zeroAddress, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaymentAdapter, PaymentStatus } from "../api/ports.js";
import { createActivityBus } from "../chain/bus.js";
import type { SubmitRequest, SubmitResult } from "../facilitator/relayer.js";
import type { NodeSigners } from "../payment/node-signers.js";
import { createFakeRecourseChain, type FakeRecourseChain } from "../sellers/recourse/chain.test-util.js";
import { b32, fixtureMissionAndResource, NOW, purchaseInput, SELLER, testDatabase, TREASURY } from "../test-db.js";
import { createDeliveryWatcher, type DeliveryWatcher } from "./delivery-watcher.js";
import { createPurchaseService } from "./purchase-service.js";
import type { SampleJudge } from "./sample-judgment.js";
import { fakeSeller, type FakeOrder } from "./sample-judgment.test-util.js";

// ---------------------------------------------------------------------------
// No chain: the SIMULATED in-memory escrow from the seller tests stands in for
// OverflowEscrow (reads), a recording relayer stands in for the real one and
// applies the state change the contract would make, and the fake seller from the
// step 4 tests serves cipher + manifest built with the real recourse-crypto.
// ---------------------------------------------------------------------------

const NODE_KEY = privateKeyToAccount(`0x${"7".padStart(64, "0")}`);
const RELAYER = "0x9999999999999999999999999999999999999999" as Address;

/** Records every submission, decodes it against the escrow ABI and applies the contract's state change to the fake escrow. */
function fakeRelayer(fake: FakeRecourseChain) {
  const calls: { to: Address; functionName: string; args: readonly unknown[]; label: string }[] = [];
  let n = 0;
  const submit = async (req: SubmitRequest): Promise<SubmitResult> => {
    const decoded = decodeFunctionData({ abi: overflowEscrowAbi, data: req.data });
    calls.push({ to: req.to, functionName: decoded.functionName, args: decoded.args ?? [], label: req.label });
    const escrow = fake.escrows.get(getAddress(req.to));
    if (escrow) {
      if (decoded.functionName === "accept") escrow.status = "Settled";
      if (decoded.functionName === "complainMismatch" || decoded.functionName === "complainPromise" || decoded.functionName === "claimTimeoutRefund") escrow.status = "Refunded";
    }
    const hash = b32(0xa000 + ++n);
    return { status: "success", hash, receipt: { blockNumber: BigInt(n), status: "success" } as unknown as TransactionReceipt };
  };
  return { address: RELAYER, submit, calls };
}

function fakeChain() {
  const state: { throws: Error | null; calls: { address: Address; functionName: string }[] } = { throws: null, calls: [] };
  return {
    state,
    simulateContract: async (a: { address: Address; functionName: string }) => {
      state.calls.push({ address: a.address, functionName: a.functionName });
      if (state.throws) throw state.throws;
      return {};
    },
  };
}

const nodeSigners: Pick<NodeSigners, "signerFor"> = {
  signerFor: async (nodeId) => {
    if (nodeId !== 1) throw new Error(`no signer for node ${nodeId}`);
    return { account: NODE_KEY, agentId: "agent-orchestrator", nodeId };
  },
};

function fakeAdapter(status: PaymentStatus) {
  const calls: string[] = [];
  const adapter: Pick<PaymentAdapter, "reconcilePayment"> = {
    reconcilePayment: async (id) => {
      calls.push(id);
      return status;
    },
  };
  return { adapter, calls };
}

describe("delivery watcher: step 9 and the failure sweeps", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  let repos: Repositories;
  let seq = 0;
  let nowSec = 1_800_000_000n;
  const seller = fakeSeller();
  const fake = createFakeRecourseChain({ sellerAddress: SELLER, now: () => nowSec });
  const bus = createActivityBus();
  const busKinds: string[] = [];
  bus.subscribe((m) => {
    if (m.type === "activity") busKinds.push(m.event.kind);
  });

  beforeAll(async () => {
    handle = await testDatabase();
    repos = handle.repos;
    await fixtureMissionAndResource(repos);
  });
  afterAll(() => handle.close());

  const purchases = () => createPurchaseService(handle.db, { publish: (e) => bus.publish(e) });

  /**
   * A purchase with its escrow_orders row backed by a fresh SIMULATED order, moved through the state machine the
   * way the route and the indexer would (RESERVED -> PAYMENT_PENDING -> ESCROW_FUNDED [-> DELIVERY_PENDING]),
   * and the matching fake escrow on chain.
   */
  async function seeded(opts: { to: "DELIVERY_PENDING" | "ESCROW_FUNDED" | "PAYMENT_UNKNOWN"; swapIndex?: number; sourceKey?: Address; revealDeadline?: string }) {
    const n = ++seq;
    const resource = await repos.resources.insert({ ...(await repos.resources.getById("resource-1"))!, id: `resource-d${n}`, manifestHash: b32(300 + n) });
    const orderId = b32(3000 + n);
    const escrowAddress = getAddress(`0x${(0x7000 + n).toString(16).padStart(40, "0")}`);
    const order: FakeOrder = seller.addOrder({ orderId, resourceId: resource.id, buyer: TREASURY, seller: SELLER, escrowAddress, swapIndex: opts.swapIndex });
    // The fake seller promises its own address as source but signs nothing; tier 3 is opted into per test.
    const escrow = { ...order.escrow, sourceKey: opts.sourceKey ?? zeroAddress, ...(opts.revealDeadline ? { revealDeadline: opts.revealDeadline } : {}) };
    const svc = purchases();
    const { purchase } = await svc.propose({
      purchase: purchaseInput({ id: `pd${n}`, resourceId: resource.id, orderIdBytes32: orderId, idempotencyKey: `k-pd${n}`, escrowAddress }),
      escrow,
      reason: "test",
      source: { kind: "oracle", reference: "t" },
      simulated: true,
    });
    const digest = b32(0xd000 + n);
    await svc.transition(purchase.id, "RESERVED", { reason: "t", source: { kind: "api", reference: "t" }, authorizationDigest: digest, simulated: true });
    await svc.transition(purchase.id, "PAYMENT_PENDING", { reason: "t", source: { kind: "api", reference: "t" }, authorizationDigest: digest, simulated: true });
    if (opts.to === "PAYMENT_UNKNOWN") {
      await svc.transition(purchase.id, "PAYMENT_UNKNOWN", { reason: "socket hang up", source: { kind: "adapter", reference: "overflow-facilitator" }, simulated: true });
      return { purchase: (await repos.purchases.getById(purchase.id))!, order, escrow, escrowAddress };
    }
    const key = order.committed.perBuyerKey;
    fake.escrows.set(escrowAddress, {
      terms: { ...escrow, orderId, buyer: TREASURY, seller: SELLER, token: USDC.address, amount: escrow.amountAtomic, bond: escrow.bondAtomic, chunkCount: order.manifest.chunkCount },
      status: "Funded",
      challengeEnd: 0n,
      revealedKey: null,
    });
    await svc.transition(purchase.id, "ESCROW_FUNDED", { reason: "OrderFunded", source: { kind: "chain", reference: b32(0xf000 + n) }, txHash: b32(0xf000 + n), escrow: { status: "Funded" }, simulated: true });
    if (opts.to === "DELIVERY_PENDING") {
      const e = fake.escrows.get(escrowAddress)!;
      e.status = "Revealed";
      e.revealedKey = key;
      e.challengeEnd = nowSec + 60n;
      await svc.transition(purchase.id, "DELIVERY_PENDING", {
        reason: "KeyRevealed",
        source: { kind: "chain", reference: b32(0xe000 + n) },
        txHash: b32(0xe000 + n),
        escrow: { status: "Revealed", revealedKey: key },
        simulated: true,
      });
    }
    return { purchase: (await repos.purchases.getById(purchase.id))!, order, escrow, escrowAddress, key };
  }

  function watcherWith(over: { chain?: ReturnType<typeof fakeChain>; adapter?: Pick<PaymentAdapter, "reconcilePayment">; judge?: SampleJudge["cached"] } = {}) {
    const relayer = fakeRelayer(fake);
    const chain = over.chain ?? fakeChain();
    const lines: string[] = [];
    const watcher: DeliveryWatcher = createDeliveryWatcher({
      db: handle.db,
      bus,
      purchases: purchases(),
      judge: { cached: over.judge ?? (() => undefined) },
      sellerUrl: seller.sellerUrl,
      fetch: seller.fetch,
      nodeSigners,
      reads: fake,
      chain,
      relayer,
      adapter: over.adapter ?? fakeAdapter({ status: "unknown" }).adapter,
      treasury: TREASURY,
      intervalMs: 60_000,
      now: () => new Date(NOW),
      log: (l) => lines.push(l),
    });
    return { watcher, relayer, chain, lines };
  }

  const kindsOf = async (purchaseId: string) => (await repos.activityEvents.listByPurchase(purchaseId)).map((e) => e.kind);

  it("honest: every chunk verifies -> one accept(sig) signed by the paying node's key; a second tick resends nothing", async () => {
    const { purchase, order, escrowAddress } = await seeded({ to: "DELIVERY_PENDING" });
    const { watcher, relayer, chain } = watcherWith();
    const cipherBefore = seller.calls.cipher;

    await watcher.tick();

    expect(relayer.calls).toHaveLength(1);
    const call = relayer.calls[0]!;
    expect(call.to).toBe(escrowAddress);
    expect(call.functionName).toBe("accept");
    expect(chain.state.calls.map((c) => c.functionName)).toEqual(["accept"]);
    const sig = call.args[0] as Hex;
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/i);
    // The signature is over OverflowEscrow.acceptDigest() of this escrow and order; the node key signed it.
    const signer = await recoverAddress({ hash: acceptDigest(escrowAddress, order.escrow.orderIdBytes32), signature: sig });
    expect(signer).toBe(NODE_KEY.address);
    // No cache (fresh process): the watcher re-fetched from the seller.
    expect(seller.calls.cipher).toBe(cipherBefore + 1);

    const events = await repos.activityEvents.listByPurchase(purchase.id);
    expect(events.map((e) => e.kind).slice(-2)).toEqual(["delivery.verified", "delivery.accept-submitted"]);
    expect(events.at(-1)!.txHash).toBe(b32(0xa001));
    expect(events.at(-1)!.message).toContain(b32(0xa001));
    expect(events.at(-1)!.simulated).toBe(true);
    expect(busKinds.filter((k) => k === "delivery.accept-submitted")).toHaveLength(1);
    // The watcher records the submission only; SETTLED is the indexer's from PaidOut.
    expect((await repos.purchases.getById(purchase.id))!.status).toBe("DELIVERY_PENDING");

    await watcher.tick();
    expect(relayer.calls).toHaveLength(1);
    expect(await kindsOf(purchase.id)).toHaveLength(events.length);
    expect(watcher.status()).toMatch(/^stopped, 2 tick\(s\), accepts=1 complaints=0 timeouts=0 failures=0, last tick 2026-10-24T16:00:00.000Z$/);
  });

  it("restart: a new watcher over the same database sees the escrow already Settled on chain and submits nothing", async () => {
    // The honest purchase above is still DELIVERY_PENDING in the database (no indexer here); the fake escrow is Settled.
    const pending = (await repos.purchases.listByStatus("DELIVERY_PENDING")).filter((p) => fake.escrows.get(getAddress(p.escrowAddress))?.status === "Settled");
    expect(pending.length).toBeGreaterThan(0);
    const { watcher, relayer, chain } = watcherWith();
    const before = await kindsOf(pending[0]!.id);
    await watcher.tick();
    expect(relayer.calls).toEqual([]);
    expect(chain.state.calls).toEqual([]);
    expect(await kindsOf(pending[0]!.id)).toEqual(before);
  });

  it("swap: the swapped chunk -> complainMismatch(i, cipherChunk, cipherProof, plainLeaf, plainProof) with proofs that verify against both roots", async () => {
    const { purchase, order, escrowAddress } = await seeded({ to: "DELIVERY_PENDING", swapIndex: 3 });
    const { watcher, relayer } = watcherWith();

    await watcher.tick();

    expect(relayer.calls).toHaveLength(1);
    const call = relayer.calls[0]!;
    expect(call.functionName).toBe("complainMismatch");
    expect(call.to).toBe(escrowAddress);
    const [i, cipherChunk, cipherProof, plainLeaf, plainProof] = call.args as [bigint, Hex, readonly Hex[], Hex, readonly Hex[]];
    expect(i).toBe(3n);
    const chunkCount = order.manifest.chunkCount;
    expect(verifyProof({ root: order.rootCipher, leaf: hashLeaf(cipherChunk), index: 3, proof: cipherProof, chunkCount })).toBe(true);
    expect(verifyProof({ root: order.manifest.rootPlain, leaf: plainLeaf, index: 3, proof: plainProof, chunkCount })).toBe(true);
    expect(plainLeaf.toLowerCase()).toBe(order.manifest.plainLeaves[3]!.toLowerCase());

    const events = await repos.activityEvents.listByPurchase(purchase.id);
    expect(events.at(-1)!.kind).toBe("delivery.complaint-submitted");
    expect(events.at(-1)!.message).toMatch(/complainMismatch\(3\)/);
    expect(events.some((e) => e.kind === "delivery.verified")).toBe(false);
    expect((await repos.purchases.getById(purchase.id))!.status).toBe("DELIVERY_PENDING");

    await watcher.tick();
    expect(relayer.calls).toHaveLength(1);
  });

  it("tier 3: records that are not signed by the promised source -> complainPromise(i, plainChunk, plainProof)", async () => {
    const { order, escrowAddress } = await seeded({ to: "DELIVERY_PENDING", sourceKey: SELLER });
    const { watcher, relayer } = watcherWith();
    await watcher.tick();
    expect(relayer.calls).toHaveLength(1);
    expect(relayer.calls[0]!.functionName).toBe("complainPromise");
    expect(relayer.calls[0]!.to).toBe(escrowAddress);
    const [i, plainChunk, plainProof] = relayer.calls[0]!.args as [bigint, Hex, readonly Hex[]];
    expect(i).toBe(0n);
    expect(hashLeaf(plainChunk).toLowerCase()).toBe(order.manifest.plainLeaves[0]!.toLowerCase());
    expect(verifyProof({ root: order.manifest.rootPlain, leaf: hashLeaf(plainChunk), index: 0, proof: plainProof, chunkCount: order.manifest.chunkCount })).toBe(true);
  });

  it("ghost: no claim before revealDeadline + margin; exactly one claimTimeoutRefund() after it", async () => {
    const deadline = 1_800_000_500n;
    const { purchase, escrowAddress } = await seeded({ to: "ESCROW_FUNDED", revealDeadline: deadline.toString() });
    const { watcher, relayer } = watcherWith();

    nowSec = deadline - 10n;
    await watcher.tick();
    expect(relayer.calls).toEqual([]);
    nowSec = deadline + 1n; // inside the margin: the chain may still be at or before the deadline
    await watcher.tick();
    expect(relayer.calls).toEqual([]);

    nowSec = deadline + 2n;
    await watcher.tick();
    expect(relayer.calls).toHaveLength(1);
    expect(relayer.calls[0]).toMatchObject({ to: escrowAddress, functionName: "claimTimeoutRefund", args: [] });
    const events = await repos.activityEvents.listByPurchase(purchase.id);
    expect(events.at(-1)!.kind).toBe("delivery.timeout-claimed");
    expect(events.at(-1)!.txHash).toBeDefined();
    // Still ESCROW_FUNDED: REFUNDED comes from the indexer's Refunded event.
    expect((await repos.purchases.getById(purchase.id))!.status).toBe("ESCROW_FUNDED");

    await watcher.tick();
    expect(relayer.calls).toHaveLength(1);
    expect(watcher.status()).toContain("timeouts=1");
    nowSec = 1_800_000_000n;
  });

  it("ghost, already refunded on chain: the status re-read skips the claim", async () => {
    const deadline = 1_800_000_500n;
    const { escrowAddress } = await seeded({ to: "ESCROW_FUNDED", revealDeadline: deadline.toString() });
    nowSec = deadline + 100n;
    fake.claimTimeoutRefund(escrowAddress); // someone else (a controller script) already claimed
    const { watcher, relayer } = watcherWith();
    await watcher.tick();
    expect(relayer.calls).toEqual([]);
    nowSec = 1_800_000_000n;
  });

  it("PAYMENT_UNKNOWN: not-settled -> FAILED_BEFORE_FUNDING with source reconciliation; funded/unknown change nothing", async () => {
    const a = await seeded({ to: "PAYMENT_UNKNOWN" });
    const notSettled = fakeAdapter({ status: "not-settled" });
    await watcherWith({ adapter: notSettled.adapter }).watcher.tick();
    expect(notSettled.calls).toContain(a.purchase.id);
    const row = (await repos.purchases.getById(a.purchase.id))!;
    expect(row.status).toBe("FAILED_BEFORE_FUNDING");
    const last = (await repos.activityEvents.listByPurchase(a.purchase.id)).at(-1)!;
    expect(last.message).toMatch(/^PAYMENT_UNKNOWN -> FAILED_BEFORE_FUNDING: reconciliation: .*\[reconciliation:0x[0-9a-f]{64}\]$/);

    const b = await seeded({ to: "PAYMENT_UNKNOWN" });
    await watcherWith({ adapter: fakeAdapter({ status: "unknown" }).adapter }).watcher.tick();
    expect((await repos.purchases.getById(b.purchase.id))!.status).toBe("PAYMENT_UNKNOWN");
    await watcherWith({ adapter: fakeAdapter({ status: "funded", txHash: b32(0x77) }).adapter }).watcher.tick();
    // funded: the indexer's OrderFunded handler moves it; the watcher never sets ESCROW_FUNDED.
    expect((await repos.purchases.getById(b.purchase.id))!.status).toBe("PAYMENT_UNKNOWN");
  });

  it("simulation revert: delivery.action-failed with the decoded reason, no relayer call, no retry next tick", async () => {
    const { purchase } = await seeded({ to: "DELIVERY_PENDING" });
    const chain = fakeChain();
    chain.state.throws = new Error("BadStatus()");
    const { watcher, relayer } = watcherWith({ chain });

    await watcher.tick();
    expect(relayer.calls).toEqual([]);
    expect(chain.state.calls.map((c) => c.functionName)).toEqual(["accept"]);
    const events = await repos.activityEvents.listByPurchase(purchase.id);
    expect(events.map((e) => e.kind).slice(-2)).toEqual(["delivery.verified", "delivery.action-failed"]);
    expect(events.at(-1)!.message).toMatch(/accept simulation reverted .*BadStatus\(\); not sent/);
    expect(events.at(-1)!.txHash).toBeUndefined();

    chain.state.throws = null;
    await watcher.tick();
    expect(relayer.calls).toEqual([]);
    expect(chain.state.calls).toHaveLength(1);
    expect(watcher.status()).toContain("failures=1");
  });

  /** Earlier cases leave DELIVERY_PENDING purchases whose fake escrow is still Revealed (a fresh watcher would rightly act on them); close them as the seller's finalizePayout would. */
  function closeOtherEscrows(except: Address) {
    for (const [address, e] of fake.escrows) if (address !== except && e.status === "Revealed") e.status = "Settled";
  }

  it("cipher that no longer matches rootCipher: delivery.action-failed once, nothing signed or sent", async () => {
    const { purchase, escrow, order, escrowAddress } = await seeded({ to: "DELIVERY_PENDING" });
    closeOtherEscrows(escrowAddress);
    // The seller now serves a different ciphertext for this order than the one it committed to.
    const tampered = seller.orders.get(order.escrow.orderIdBytes32.toLowerCase())!;
    tampered.cipherChunks = [...tampered.cipherChunks].reverse();
    const { watcher, relayer, chain } = watcherWith();
    await watcher.tick();
    await watcher.tick();
    expect(relayer.calls.filter((c) => c.to === escrowAddress)).toEqual([]);
    expect(chain.state.calls.filter((c) => c.address === escrowAddress)).toEqual([]);
    const events = (await repos.activityEvents.listByPurchase(purchase.id)).filter((e) => e.kind === "delivery.action-failed");
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toContain(`does not Merkle to the escrow's rootCipher ${escrow.rootCipher}`);
  });

  it("uses the judge's cache when present instead of re-fetching", async () => {
    const { purchase, order, escrowAddress } = await seeded({ to: "DELIVERY_PENDING" });
    closeOtherEscrows(escrowAddress);
    const cached = { cipherChunks: order.cipherChunks, plainLeaves: order.manifest.plainLeaves as Hex[], manifest: order.manifest };
    const before = { ...seller.calls };
    const { watcher, relayer } = watcherWith({ judge: (id) => (id === purchase.id ? cached : undefined) });
    await watcher.tick();
    expect(relayer.calls.map((c) => [c.to, c.functionName])).toEqual([[escrowAddress, "accept"]]);
    expect(seller.calls).toEqual(before);
  });

  it("bus: a purchase.status or escrow.revealed activity event triggers a tick while started; overlapping ticks are coalesced", async () => {
    const { watcher, lines } = watcherWith();
    watcher.start();
    try {
      const before = watcher.status();
      bus.publish({ id: "evt-bus-1", at: NOW, kind: "purchase.status", message: "t", simulated: true });
      bus.publish({ id: "evt-bus-2", at: NOW, kind: "escrow.revealed", message: "t", simulated: true });
      bus.publish({ id: "evt-bus-3", at: NOW, kind: "mission.created", message: "ignored", simulated: true });
      await watcher.tick();
      const ticks = Number(/(\d+) tick\(s\)/.exec(watcher.status())![1]);
      expect(ticks).toBeGreaterThanOrEqual(2);
      expect(ticks).toBeLessThanOrEqual(3);
      expect(before).toMatch(/^running, 0 tick\(s\)/);
    } finally {
      watcher.stop();
    }
    expect(watcher.status()).toMatch(/^stopped/);
    expect(lines.some((l) => /tick error/.test(l))).toBe(false);
  });
});
