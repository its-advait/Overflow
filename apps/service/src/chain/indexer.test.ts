import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPurchaseService } from "../orchestration/purchase-service.js";
import { b32, fixtureMissionAndResource, purchaseInput, testDatabase } from "../test-db.js";
import { createActivityBus, type BusMessage } from "./bus.js";
import type { RawLog } from "./client.js";
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
  deployBlock: FIXTURE.deployBlock,
  pollMs: 2000,
  reorgDepth: 12,
  chunkBlocks: 5, // OrderCreated (103) and OrderFunded (104) land in one chunk: tests mid-chunk escrow discovery
};

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
    const escrowTerms = (purchaseId: string, orderId: `0x${string}`, escrowAddress: `0x${string}`) => ({
      purchaseId,
      orderIdBytes32: orderId,
      escrowAddress,
      sellerAddress: FIXTURE.seller,
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
    });
    // p1: order 1, waiting on payment. p2: order 2 on the coinbase path (reservation digest d2).
    // p3: order 3 still PROPOSED, so its PaidOut must be refused. Each in its own resource to satisfy the active-purchase index.
    await handle.repos.resources.insert({ ...(await handle.repos.resources.getById("resource-1"))!, id: "resource-2" });
    await handle.repos.resources.insert({ ...(await handle.repos.resources.getById("resource-1"))!, id: "resource-3" });
    for (const [id, order, escrow, resourceId] of [
      ["p1", b32(1), FIXTURE.escrow1, "resource-1"],
      ["p2", b32(2), FIXTURE.escrow2, "resource-2"],
      ["p3", b32(3), FIXTURE.escrow3, "resource-3"],
    ] as const) {
      await svc.propose({
        purchase: purchaseInput({ id, orderIdBytes32: order, escrowAddress: escrow, resourceId, idempotencyKey: `k-${id}` }),
        reason: "fixture",
        source: { kind: "oracle", reference: "test" },
      });
      await handle.repos.escrowOrders.insert(escrowTerms(id, order, escrow));
    }
    for (const [id, digest] of [
      ["p1", b32(0xd1)],
      ["p2", b32(0xd2)],
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
    expect(r.logsSeen).toBe(18);
    expect(r.logsInserted).toBe(18);

    // Every log is a chain_transactions row, confirmed, with its decoded args as strings.
    const p1Tx = await handle.repos.chainTransactions.listByPurchase("p1");
    expect(p1Tx.map((t) => t.eventName)).toEqual(["OrderCreated", "Paid", "OrderFunded", "KeyRevealed", "Accepted", "PaidOut"]);
    expect(p1Tx.every((t) => t.confirmed)).toBe(true);
    expect(p1Tx[1]!.args).toMatchObject({ id: "1", to: FIXTURE.escrow1, value: FIXTURE.amount });

    // Purchases moved only along the state machine, through confirmed events.
    expect((await handle.repos.purchases.getById("p1"))!.status).toBe("SETTLED");
    expect((await handle.repos.purchases.getById("p2"))!.status).toBe("REFUNDED");
    expect((await handle.repos.purchases.getById("p3"))!.status).toBe("PROPOSED"); // PaidOut refused: never funded
    expect(warnings.some((w) => w.includes("PaidOut") && w.includes("refused"))).toBe(true);

    // Escrow mirror follows the contract.
    const e1 = (await handle.repos.escrowOrders.getByPurchase("p1"))!;
    expect(e1.status).toBe("Settled");
    expect(e1.revealedKey).toBe(b32(0x77));
    const e2 = (await handle.repos.escrowOrders.getByPurchase("p2"))!;
    expect(e2.status).toBe("Refunded");
    expect(e2.refundReason).toBe("timeout: no reveal before deadline");
    expect((await handle.repos.escrowOrders.getByPurchase("p3"))!.status).toBe("Created");

    // Reservation mirrored then released; budget not restored (USDC had moved) so p2 was not RELEASED.
    const res = (await handle.repos.reservations.getByDigest(b32(0xd2)))!;
    expect(res.status).toBe("released");
    expect(res.purchaseId).toBe("p2");

    // Agent node id from NodeCreated; seller history from reveal + cheat.
    expect((await handle.repos.agents.getById("agent-orchestrator"))!.nodeId).toBe(1);
    const seller = (await handle.repos.sellerHistory.get(FIXTURE.seller))!;
    expect(seller).toMatchObject({ onTimeReveals: 1, provenCheats: 1, flagged: true });

    // Activity: one event per log (transitions write theirs through PurchaseService).
    const activity = await handle.repos.activityEvents.listRecent(200);
    const kinds = activity.map((a) => a.kind);
    for (const k of ["treasury.node", "treasury.policy", "escrow.created", "treasury.paid", "escrow.funded", "purchase.status", "escrow.accepted", "escrow.settled", "treasury.reserved", "escrow.refunded", "seller.flagged", "treasury.released"]) {
      expect(kinds).toContain(k);
    }
    expect(activity.filter((a) => a.purchaseId === "p1" && a.txHash).length).toBe(6);
    expect(r.events.length).toBe(published.filter((m) => m.type === "activity").length);
    expect(published.filter((m) => m.type === "indexer").at(-1)).toMatchObject({ status: { state: "idle", cursor: "115", head: "115", trackedEscrows: 3 } });

    // Cursor advanced; escrows tracked (including the one created mid-chunk).
    expect((await handle.repos.indexerCursors.get("indexer:base-sepolia"))!.lastBlock).toBe("115");
    expect(indexer.trackedEscrows().map((a) => a.toLowerCase())).toEqual([FIXTURE.escrow1, FIXTURE.escrow2, FIXTURE.escrow3].map((a) => a.toLowerCase()));
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
    expect((await handle.repos.activityEvents.listRecent(500)).length).toBe(before);
    expect((await handle.repos.purchases.getById("p1"))!.status).toBe("SETTLED");
    expect(second.trackedEscrows()).toHaveLength(3); // rediscovered from stored OrderCreated rows
  });

  it("a reorg inside the re-read window withdraws confirmation, keeps the record", async () => {
    const dropped = source.logs.find((l) => l.blockNumber === "110" && l.logIndex === 1)!; // NodePaused
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
