import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPurchaseService } from "../orchestration/purchase-service.js";
import { b32, fixtureMissionAndResource, purchaseInput, testDatabase } from "../test-db.js";
import { createActivityBus, type BusMessage } from "./bus.js";
import type { RawLog } from "./log-source.js";
import type { IndexerConfig } from "./config.js";
import { fakeLogSource } from "./fake-source.js";
import { FIXTURE } from "./fixtures/build-fixture.js";
import { createIndexer, type Indexer } from "./indexer.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/base-sepolia-logs.json", import.meta.url), "utf8")) as {
  logs: RawLog[];
};

const config: IndexerConfig = {
  chainId: 84532,
  rpcUrl: "http://fake.invalid",
  treasury: FIXTURE.treasury,
  escrowFactory: FIXTURE.factory,
  usdc: FIXTURE.usdc,
  deployBlock: FIXTURE.deployBlock,
  pollMs: 2000,
  reorgDepth: 12,
  chunkBlocks: 5, // OrderCreated (103) and OrderFunded (104) land in one chunk: tests mid-chunk escrow discovery
};

const activityOf = <T extends { kind: string }>(events: T[], kind: string): T[] => events.filter((e) => e.kind === kind);

describe("chain indexer (SIMULATED fixture replay)", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  let source: ReturnType<typeof fakeLogSource>;
  let indexer: Indexer;
  const bus = createActivityBus();
  const published: BusMessage[] = [];
  const warnings: string[] = [];

  beforeAll(async () => {
    handle = await testDatabase();
    await fixtureMissionAndResource(handle.repos);
    const svc = createPurchaseService(handle.db);
    const escrowTerms = (purchaseId: string, orderId: `0x${string}`, escrowAddress: `0x${string}`, sellerAddress: `0x${string}` = FIXTURE.seller) => ({
      purchaseId,
      orderIdBytes32: orderId,
      escrowAddress,
      sellerAddress,
      amountAtomic: FIXTURE.amount,
      bondAtomic: "0",
      termsHash: b32(9),
      manifestHash: b32(5),
      rootPlain: b32(21),
      rootCipher: b32(22),
      keyCommitment: b32(23),
      revealDeadline: "1800000000",
      challengeWindow: "600",
      sourceKey: FIXTURE.owner,
      minTimestamp: "0",
      chunkCount: 7,
    });
    // p1: order 1, waiting on payment. p2: order 2 on the coinbase path (reservation digest d2, seller bond 2.4 USDC).
    // p3: order 3 still PROPOSED, so its PaidOut must be refused. p4: a direct x402 API purchase (no escrow order).
    // p5: order 4 from a second seller (bond 2.4 USDC) whose swapped chunk is proven onchain.
    // Each in its own resource to satisfy the active-purchase index.
    for (const id of ["resource-2", "resource-3", "resource-4", "resource-5"]) {
      await handle.repos.resources.insert({ ...(await handle.repos.resources.getById("resource-1"))!, id });
    }
    for (const [id, order, escrow, resourceId, seller] of [
      ["p1", b32(1), FIXTURE.escrow1, "resource-1", FIXTURE.seller],
      ["p2", b32(2), FIXTURE.escrow2, "resource-2", FIXTURE.seller],
      ["p3", b32(3), FIXTURE.escrow3, "resource-3", FIXTURE.seller],
      ["p5", b32(4), FIXTURE.escrow4, "resource-5", FIXTURE.cheater],
    ] as const) {
      await svc.propose({
        purchase: purchaseInput({ id, orderIdBytes32: order, escrowAddress: escrow, sellerAddress: seller, resourceId, idempotencyKey: `k-${id}` }),
        reason: "fixture",
        source: { kind: "oracle", reference: "test" },
      });
      await handle.repos.escrowOrders.insert({ ...escrowTerms(id, order, escrow, seller), ...(id === "p2" || id === "p5" ? { bondAtomic: FIXTURE.bond } : {}) });
    }
    await svc.propose({
      purchase: purchaseInput({
        id: "p4",
        orderIdBytes32: b32(4),
        escrowAddress: FIXTURE.apiSeller,
        sellerAddress: FIXTURE.apiSeller,
        resourceId: "resource-4",
        idempotencyKey: "k-p4",
        amountAtomic: FIXTURE.apiAmount,
        allocations: [{ agentId: "agent-research", department: "research", amountAtomic: FIXTURE.apiAmount }],
      }),
      reason: "fixture: direct x402 API purchase",
      source: { kind: "oracle", reference: "test" },
    });
    for (const [id, digest] of [
      ["p1", b32(0xd1)],
      ["p2", b32(0xd2)],
      ["p4", b32(0xd4)],
      ["p5", b32(0xd5)],
    ] as const) {
      await svc.transition(id, "RESERVED", { reason: "signed", source: { kind: "adapter", reference: "t" }, authorizationDigest: digest });
      await svc.transition(id, "PAYMENT_PENDING", { reason: "sent", source: { kind: "adapter", reference: "t" }, authorizationDigest: digest });
    }
    bus.subscribe((m) => published.push(m));
    source = fakeLogSource(fixture.logs, BigInt(FIXTURE.head));
    indexer = createIndexer({ db: handle.db, source, config, bus, log: () => undefined, warn: (m) => warnings.push(m) });
  });
  afterAll(() => handle.close());

  it("replays the fixture into the right records", async () => {
    const r = await indexer.tick();
    expect(r.fromBlock).toBe(100n);
    expect(r.toBlock).toBe(115n);
    expect(r.logsSeen).toBe(33);
    expect(r.logsInserted).toBe(33);

    // Every log is a chain_transactions row, confirmed, with its decoded args as strings.
    const p1Tx = await handle.repos.chainTransactions.listByPurchase("p1");
    expect(p1Tx.map((t) => t.eventName)).toEqual(["OrderCreated", "Transfer", "Paid", "OrderFunded", "KeyRevealed", "Accepted", "PaidOut"]);
    expect(p1Tx.every((t) => t.confirmed)).toBe(true);
    expect(p1Tx[2]!.args).toMatchObject({ id: "1", to: FIXTURE.escrow1, value: FIXTURE.amount });
    // USDC transfers were fetched with topic filters, only for the treasury.
    expect(source.calls.some((c) => c.topics?.length === 2 && c.addresses[0] === FIXTURE.usdc)).toBe(true);
    expect(source.calls.some((c) => c.topics?.length === 3 && c.topics[1] === null)).toBe(true);

    // Purchases moved only along the state machine, through confirmed events.
    expect((await handle.repos.purchases.getById("p1"))!.status).toBe("SETTLED");
    expect((await handle.repos.purchases.getById("p2"))!.status).toBe("REFUNDED");
    expect((await handle.repos.purchases.getById("p3"))!.status).toBe("PROPOSED"); // PaidOut refused: never funded
    expect((await handle.repos.purchases.getById("p5"))!.status).toBe("REFUNDED"); // proven mismatch
    expect(warnings.some((w) => w.includes("PaidOut") && w.includes("refused"))).toBe(true);

    // Escrow mirror follows the contract.
    const e1 = (await handle.repos.escrowOrders.getByPurchase("p1"))!;
    expect(e1.status).toBe("Settled");
    expect(e1.revealedKey).toBe(b32(0x77));
    expect(e1.challengeEnd).toBe(FIXTURE.challengeEnd); // from KeyRevealed(key, challengeEnd)
    const e2 = (await handle.repos.escrowOrders.getByPurchase("p2"))!;
    expect(e2.status).toBe("Refunded");
    expect(e2.refundReason).toBe("timeout");
    expect(e2.challengeEnd).toBeUndefined();
    expect((await handle.repos.escrowOrders.getByPurchase("p3"))!.status).toBe("Created");
    const e4 = (await handle.repos.escrowOrders.getByPurchase("p5"))!;
    expect(e4).toMatchObject({ status: "Refunded", refundReason: "mismatch", revealedKey: b32(0x78), challengeEnd: FIXTURE.challengeEnd });

    // Reservation mirrored then released; refunded=false (USDC had moved) so p2 was not RELEASED.
    const res = (await handle.repos.reservations.getByDigest(b32(0xd2)))!;
    expect(res.status).toBe("released");
    expect(res.purchaseId).toBe("p2");

    // Agent node id from NodeCreated; seller history: the honest seller opened three orders and revealed once on time
    // (a timeout never flags anyone); the cheater's one order ended in a proven cheat, keyed by the emitting escrow.
    expect((await handle.repos.agents.getById("agent-orchestrator"))!.nodeId).toBe(1);
    const seller = (await handle.repos.sellerHistory.get(FIXTURE.seller))!;
    expect(seller).toMatchObject({ orders: 3, onTimeReveals: 1, lateReveals: 0, provenCheats: 0, flagged: false, sellerId: "seller-honest" });
    const cheater = (await handle.repos.sellerHistory.get(FIXTURE.cheater))!;
    expect(cheater).toMatchObject({ orders: 1, onTimeReveals: 1, provenCheats: 1, flagged: true });
    // CheatProven and CheatRecorded both landed on p5 through the escrow address, with the tx hash.
    const flagged = activityOf(await handle.repos.activityEvents.listRecent(500), "seller.flagged");
    expect(flagged.map((e) => [e.purchaseId, Boolean(e.txHash)])).toEqual([["p5", true]]);
    expect(activityOf(await handle.repos.activityEvents.listRecent(500), "seller.cheat-recorded").map((e) => e.purchaseId)).toEqual(["p5"]);

    // Ledger: one logical entry per money event (see ledger/posting.test.ts for the rules themselves).
    // funding, OrderFunded x3, PaidOut p1 (2 department lines), Refunded p2 (price + bond), direct p4, Refunded p5 (price + bond)
    expect(r.entries.length).toBe(11);
    const treasury = await handle.repos.financialEntries.balance("usdc-treasury");
    expect((treasury.debitsAtomic - treasury.creditsAtomic).toString()).toBe("39800000"); // 50 - 12 - 12 + 14.4 - 3 - 12 + 14.4 USDC

    // Activity: one event per log (transitions write theirs through PurchaseService).
    const activity = await handle.repos.activityEvents.listRecent(200);
    const kinds = activity.map((a) => a.kind);
    for (const k of ["treasury.node", "treasury.policy", "escrow.created", "treasury.paid", "escrow.funded", "purchase.status", "escrow.accepted", "escrow.settled", "treasury.reserved", "escrow.refunded", "seller.flagged", "treasury.released", "usdc.transfer", "seller.cheat-recorded"]) {
      expect(kinds).toContain(k);
    }
    expect(activity.filter((a) => a.purchaseId === "p1" && a.txHash).length).toBe(7);
    // Real escrow events carry no orderId: the emitting address linked them. KeyRevealed recorded the challenge end; Accepted the node.
    expect(activity.find((a) => a.kind === "purchase.status" && a.message.includes("KeyRevealed"))!.message).toContain(`challenge window open until ${FIXTURE.challengeEnd}`);
    expect(activity.find((a) => a.kind === "escrow.accepted")!.message).toContain("node 1");
    // CheatProven (escrow) flags the seller; CheatRecorded (factory) is its own kind.
    expect(activity.filter((a) => a.kind === "seller.flagged").length).toBe(1);
    expect(activity.filter((a) => a.kind === "seller.cheat-recorded").length).toBe(1);
    expect(r.events.length).toBe(published.filter((m) => m.type === "activity").length);
    expect(published.filter((m) => m.type === "indexer").at(-1)).toMatchObject({ status: { state: "idle", cursor: "115", head: "115", trackedEscrows: 4 } });

    // Cursor advanced; escrows tracked (including the one created mid-chunk).
    expect((await handle.repos.indexerCursors.get("indexer:base-sepolia"))!.lastBlock).toBe("115");
    expect(indexer.trackedEscrows().map((a) => a.toLowerCase())).toEqual([FIXTURE.escrow1, FIXTURE.escrow2, FIXTURE.escrow3, FIXTURE.escrow4].map((a) => a.toLowerCase()));
    // The chunk holding OrderCreated(103)+OrderFunded(104) was re-queried for the new escrow.
    expect(source.calls.some((c) => c.fromBlock === 100n && c.addresses.length === 1 && c.addresses[0]!.toLowerCase() === FIXTURE.escrow1.toLowerCase())).toBe(true);
  });

  it("a restart resumes from the cursor without duplicates", async () => {
    const before = (await handle.repos.activityEvents.listRecent(500)).length;
    const second = createIndexer({ db: handle.db, source, config, bus, log: () => undefined, warn: () => undefined });
    const r = await second.tick();
    expect(r.fromBlock).toBe(104n); // 115 + 1 - 12
    expect(r.logsSeen).toBeGreaterThan(0);
    expect(r.logsInserted).toBe(0);
    expect(r.unconfirmed).toBe(0);
    expect(r.entries).toEqual([]); // a replay never double-posts
    expect((await handle.repos.financialEntries.listAll()).length).toBe(11);
    expect((await handle.repos.activityEvents.listRecent(500)).length).toBe(before);
    expect((await handle.repos.purchases.getById("p1"))!.status).toBe("SETTLED");
    expect(second.trackedEscrows()).toHaveLength(4); // rediscovered from stored OrderCreated rows
  });

  it("a reorg inside the re-read window withdraws confirmation, keeps the record", async () => {
    const dropped = source.logs.find((l) => l.blockNumber === "110" && l.logIndex === 2)!; // NodePaused
    source.logs = source.logs.filter((l) => l !== dropped);
    source.head = 116n;
    const r = await indexer.tick();
    expect(r.unconfirmed).toBe(1);
    const row = (await handle.repos.chainTransactions.getByLog(dropped.transactionHash, dropped.logIndex))!;
    expect(row.confirmed).toBe(false);
    expect(row.eventName).toBe("NodePaused");
    expect(r.events.map((e) => e.kind)).toEqual(["indexer.unconfirmed"]);
    // It comes back: confirmation restored, no new row.
    source.logs.push(dropped);
    const again = await indexer.tick();
    expect(again.logsInserted).toBe(0);
    expect((await handle.repos.chainTransactions.getByLog(dropped.transactionHash, dropped.logIndex))!.confirmed).toBe(true);
  });

  it("an RPC failure is reported in status and retried from the same cursor", async () => {
    const good = source.getBlockNumber;
    source.getBlockNumber = async () => {
      throw new Error("rpc down");
    };
    await expect(indexer.tick()).rejects.toThrow("rpc down");
    expect(indexer.status().lastError).toBe("rpc down");
    source.getBlockNumber = good;
    const r = await indexer.tick();
    expect(r.fromBlock).toBe(105n);
    expect(indexer.status().lastError).toBeUndefined();
  });
});
