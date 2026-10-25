import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActivityBus, type BusMessage } from "../chain/bus.js";
import { FIXTURE } from "../chain/fixtures/build-fixture.js";
import { replayFixture } from "./test-fixture.js";
import { createReconciliation, EXCEPTION_TYPE } from "./reconciliation.js";

describe("reconciliation (SIMULATED fixture, fake balances)", () => {
  let r: Awaited<ReturnType<typeof replayFixture>>;
  let recon: ReturnType<typeof createReconciliation>;
  const bus = createActivityBus();
  const published: BusMessage[] = [];
  const LEDGER_TREASURY = 39_800_000n; // 50 - 12 - 12 + 14.4 - 3 - 12 + 14.4 USDC

  beforeAll(async () => {
    r = await replayFixture();
    bus.subscribe((m) => published.push(m));
    recon = createReconciliation({ db: r.handle.db, reader: r.source, treasury: FIXTURE.treasury, usdc: FIXTURE.usdc, bus, log: () => undefined });
  });
  afterAll(() => r.handle.close());

  it("a chain that matches the books: the only difference is the PaidOut the books never saw funded", async () => {
    r.source.setBalance(FIXTURE.usdc, FIXTURE.treasury, LEDGER_TREASURY);
    const run = await recon.run("test");
    expect(run.blockNumber).toBe("115"); // the indexer cursor
    expect(run.treasuryChainAtomic).toBe(LEDGER_TREASURY.toString());
    expect(run.treasuryLedgerAtomic).toBe(LEDGER_TREASURY.toString());
    expect(run.treasuryDifferenceAtomic).toBe("0");
    expect(run.escrowsChecked).toBe(4);
    expect(run.materialityAtomic).toBe("10000");
    // Every order is recorded, matched or not: p1 settled and p2 refunded net to zero, p3 was never funded.
    expect(run.escrows.map((e) => [e.purchaseId, e.status, e.open, e.expectedAtomic, e.ledgerAtomic, e.differenceAtomic, e.material]).sort()).toEqual([
      ["p1", "Settled", false, "0", "0", "0", false],
      ["p2", "Refunded", false, "0", "0", "0", false],
      ["p3", "Created", true, "0", "0", "0", false],
      ["p5", "Refunded", false, "0", "0", "0", false],
    ]);
    // Closed orders read no balance; the open Created order (p3) does, since settle() may already have funded it.
    expect(run.escrows.filter((e) => e.status !== "Created").every((e) => e.chainAtomic === undefined)).toBe(true);
    expect(run.escrows.find((e) => e.purchaseId === "p3")!.chainAtomic).toBe("0");
    expect(run.eventsChecked).toBe(7); // PaidOut x2, Refunded x2, Paid x3
    expect(run.differences.map((d) => d.kind)).toEqual(["event-coverage"]);
    // The refused PaidOut handler rolled back its purchase link, so the difference names the event, not p3.
    expect(run.differences[0]).toMatchObject({ subject: expect.stringMatching(/^event:0xf+000d:1$/), differenceAtomic: FIXTURE.amount, material: true });
    expect(run.exceptionIds.length).toBe(1);
    expect(run.status).toBe("differences");
    expect((await r.handle.repos.reconciliationRuns.latest())!.id).toBe(run.id);
    const ex = (await r.handle.repos.exceptions.listOpen())[0]!;
    expect(ex).toMatchObject({ type: EXCEPTION_TYPE, amountAtomic: FIXTURE.amount, status: "open" });
  });

  it("a planted 0.50 USDC difference raises an exception for the controller; 0.005 USDC does not", async () => {
    r.source.setBalance(FIXTURE.usdc, FIXTURE.treasury, LEDGER_TREASURY + 500_000n);
    const run = await recon.run("test");
    expect(run.treasuryDifferenceAtomic).toBe("500000");
    const treasury = run.differences.find((d) => d.kind === "treasury")!;
    expect(treasury).toMatchObject({ subject: "treasury", chainAtomic: (LEDGER_TREASURY + 500_000n).toString(), ledgerAtomic: LEDGER_TREASURY.toString(), material: true });
    expect(run.exceptionIds.length).toBe(1); // the p3 exception is already open and is not reopened
    const open = await r.handle.repos.exceptions.listOpen();
    expect(open.map((e) => e.subject).sort()).toEqual(["event:0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000d:1", "treasury"]);
    expect(open.find((e) => e.subject === "treasury")).toMatchObject({ type: EXCEPTION_TYPE, amountAtomic: "500000" });
    expect(published.filter((m) => m.type === "activity" && m.event.kind === "exception.opened").length).toBe(2);

    // Still off by 0.50: no second exception for the same subject.
    const again = await recon.run("test");
    expect(again.exceptionIds).toEqual([]);
    expect((await r.handle.repos.exceptions.listOpen()).length).toBe(2);

    // Below materiality (0.005 USDC): recorded as a difference, no exception.
    await r.handle.repos.exceptions.resolve(open.find((e) => e.subject === "treasury")!.id, "controller");
    r.source.setBalance(FIXTURE.usdc, FIXTURE.treasury, LEDGER_TREASURY + 5_000n);
    const small = await recon.run("test");
    expect(small.treasuryDifferenceAtomic).toBe("5000");
    expect(small.differences.find((d) => d.kind === "treasury")!.material).toBe(false);
    expect(small.exceptionIds).toEqual([]);
    expect((await r.handle.repos.exceptions.listOpen()).map((e) => e.subject)).toEqual(["event:0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000d:1"]);
  });

  it("an open escrow whose balance disagrees with its deposit line is flagged, and a refunded order carries no expense", async () => {
    // Make order 3 look funded on the books' side of the mirror without any OrderFunded entry: Funded status, chain holds 12 USDC.
    await r.handle.repos.escrowOrders.setStatus("p3", "Funded");
    r.source.setBalance(FIXTURE.usdc, FIXTURE.escrow3, 12_000_000n);
    r.source.setBalance(FIXTURE.usdc, FIXTURE.treasury, LEDGER_TREASURY);
    const run = await recon.run("test", 115n);
    const escrow = run.differences.find((d) => d.kind === "escrow")!;
    expect(escrow).toMatchObject({ subject: "escrow:p3", chainAtomic: "12000000", ledgerAtomic: "0", differenceAtomic: "12000000", purchaseId: "p3", material: true });
    expect((await r.handle.repos.exceptions.findOpenBySubject(EXCEPTION_TYPE, "escrow:p3"))!.amountAtomic).toBe("12000000");
    // Closed orders net to zero; the refunded order has no expense line at all.
    expect(run.differences.some((d) => d.subject === "escrow:p1" || d.subject === "escrow:p2")).toBe(false);
    const p2 = await r.handle.repos.financialEntries.listForPurchase("p2");
    expect(p2.filter((e) => e.debitAccount === "data-expense")).toEqual([]);
    expect((await r.handle.repos.purchases.getById("p2"))!.status).toBe("REFUNDED");
  });

  it("GET /api/reconciliation shape: the stored run is what the route returns", async () => {
    const latest = await recon.latest();
    expect(latest).toBeDefined();
    expect(latest!.trigger).toBe("test");
    expect(published.some((m) => m.type === "activity" && m.event.kind === "reconciliation.difference")).toBe(true);
  });
});
