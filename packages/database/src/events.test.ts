import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UniqueViolationError, isUniqueViolation } from "./errors";
import { SOURCE_EVENT_UNIQUE_CONSTRAINT, TX_LOG_UNIQUE_CONSTRAINT } from "./repositories";
import { chainTransactions as chainTransactionsTable } from "./schema";
import { ADDR, b32, freshDatabase, purchaseInput, seedFixture } from "./test-helpers";

describe("chain events and ledger rows book exactly once", () => {
  let handle: Awaited<ReturnType<typeof freshDatabase>>;
  let purchaseId: string;
  beforeAll(async () => {
    handle = await freshDatabase();
    await seedFixture(handle.repos);
    purchaseId = (await handle.repos.purchases.create(purchaseInput())).id;
  });
  afterAll(() => handle.close());

  it("records a (tx_hash, log_index) once and reports replays", async () => {
    const { chainTransactions } = handle.repos;
    const event = {
      purchaseId,
      txHash: b32(100),
      logIndex: 3,
      blockNumber: "123456",
      contractAddress: ADDR,
      eventName: "OrderFunded",
      args: { orderId: b32(1), amount: "12000000" },
    };
    const first = await chainTransactions.record(event);
    const replay = await chainTransactions.record(event);
    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.row.id).toBe(first.row.id);
    expect((await chainTransactions.listByTxHash(b32(100))).length).toBe(1);

    // Same tx, different log index is a different event.
    const other = await chainTransactions.record({ ...event, logIndex: 4, eventName: "KeyRevealed" });
    expect(other.inserted).toBe(true);
  });

  it("the raw unique constraint on (tx_hash, log_index) is enforced by the database", async () => {
    await expect(
      handle.db.insert(chainTransactionsTable).values({
        id: "dup",
        txHash: b32(100),
        logIndex: 3,
        blockNumber: "1",
        contractAddress: ADDR,
        eventName: "OrderFunded",
        args: {},
      }),
    ).rejects.toSatisfy((e: unknown) => isUniqueViolation(e, TX_LOG_UNIQUE_CONSTRAINT));
  });

  it("rejects a duplicate financial entry for the same source event", async () => {
    const { financialEntries, chainTransactions } = handle.repos;
    const funded = (await chainTransactions.listByTxHash(b32(100)))[0]!;
    const entry = {
      purchaseId,
      debitAccount: "escrow-deposit" as const,
      creditAccount: "usdc-treasury" as const,
      amountAtomic: "12000000",
      memo: "Escrow funded for purchase",
      sourceEventId: funded.id,
      txHash: funded.txHash,
    };
    const posted = await financialEntries.post(entry);
    expect(posted.sourceEventId).toBe(funded.id);

    let caught: unknown;
    try {
      await financialEntries.post({ ...entry, memo: "second attempt" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UniqueViolationError);
    expect((caught as UniqueViolationError).constraint).toBe(SOURCE_EVENT_UNIQUE_CONSTRAINT);
    expect((await financialEntries.listForPurchase(purchaseId)).length).toBe(1);
  });

  it("rejects debit == credit before the database and never stores floats", async () => {
    const { financialEntries } = handle.repos;
    await expect(
      financialEntries.post({
        debitAccount: "usdc-treasury",
        creditAccount: "usdc-treasury",
        amountAtomic: "1",
        memo: "bad",
        sourceEventId: "synthetic-1",
      }),
    ).rejects.toThrow(/differ/);
    await expect(
      financialEntries.post({
        debitAccount: "usdc-treasury",
        creditAccount: "owner-contribution",
        amountAtomic: "100.5",
        memo: "bad",
        sourceEventId: "synthetic-2",
      }),
    ).rejects.toThrow();
    expect(await financialEntries.getBySourceEvent("synthetic-1")).toBeUndefined();
  });

  it("balances are summed with bigint", async () => {
    const { financialEntries } = handle.repos;
    await financialEntries.post({
      debitAccount: "usdc-treasury",
      creditAccount: "owner-contribution",
      amountAtomic: "100000000000000000000000000", // 1e26: beyond Number precision
      memo: "Controller funds the treasury (test)",
      sourceEventId: "fund-1",
    });
    const treasury = await financialEntries.balance("usdc-treasury");
    expect(treasury.debitsAtomic).toBe(100000000000000000000000000n);
    expect(treasury.creditsAtomic).toBe(12000000n);
    const escrow = await financialEntries.balance("escrow-deposit");
    expect(escrow.debitsAtomic - escrow.creditsAtomic).toBe(12000000n);
  });
});
