import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE } from "../../chain/fixtures/build-fixture.js";
import { createReconciliation } from "../../ledger/reconciliation.js";
import { replayFixture } from "../../ledger/test-fixture.js";
import { createApp } from "../app.js";

// The books the way a controller reads them (SPEC "Finance layer for Hyphenate"):
// GET /api/ledger, GET/POST /api/reconciliation, GET /api/exceptions + decide, driven by the
// SIMULATED fixture with p3's PaidOut removed, so the chain is one honest order (p1, Fusion split
// research 8.40 / finance 3.60), one timeout refund (p2, bond forfeited), one direct x402 buy (p4) and one
// proven-mismatch refund (p5, bond forfeited).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json() as Promise<any>;
const JSON_HEADERS = { "content-type": "application/json" };

/** 50 funding - 12 p1 - 12 p2 + 12 refund + 2.4 bond - 3 direct - 12 p5 + 12 refund + 2.4 bond. */
const LEDGER_TREASURY = 39_800_000n;

describe("ledger, reconciliation and exceptions API (SIMULATED fixture)", () => {
  let r: Awaited<ReturnType<typeof replayFixture>>;
  let app: ReturnType<typeof createApp>["app"];
  const get = (path: string) => app.request(path);
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

  beforeAll(async () => {
    r = await replayFixture({ exclude: (l) => l.address.toLowerCase() === FIXTURE.escrow3.toLowerCase() });
    const recon = createReconciliation({ db: r.handle.db, reader: r.source, treasury: FIXTURE.treasury, usdc: FIXTURE.usdc, log: () => undefined });
    app = createApp({
      db: r.handle.db,
      ports: { reconciliation: { run: (trigger) => recon.run(trigger) } },
      session: { organizationId: "org-demo", principal: "owner", ownerAddress: null },
      treasury: FIXTURE.treasury,
    }).app;
  });
  afterAll(() => r.handle.close());

  const line = (e: { debitAccount: string; creditAccount: string; amountAtomic: string; purchaseId?: string; department?: string }) =>
    [e.purchaseId ?? "-", e.debitAccount, e.creditAccount, e.amountAtomic, e.department ?? "-"].join(" ");

  it("journal: the honest order and the refunded order book exactly the spec's entries, every row linked to its tx", async () => {
    const res = await get("/api/ledger");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.entries).toHaveLength(11);
    for (const e of body.entries) expect(e.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.entries.map(line).sort()).toEqual(
      [
        "- usdc-treasury owner-contribution 50000000 -", // controller funds the treasury
        "p1 escrow-deposit usdc-treasury 12000000 -", // escrow funded
        "p1 data-expense escrow-deposit 8400000 research", // delivery accepted, Fusion split
        "p1 data-expense escrow-deposit 3600000 finance",
        "p2 escrow-deposit usdc-treasury 12000000 -",
        "p2 usdc-treasury escrow-deposit 12000000 -", // timeout refund: never an expense
        "p2 usdc-treasury other-income-seller-forfeiture 2400000 -", // bond forfeited
        "p4 data-expense usdc-treasury 3000000 research", // direct x402 purchase
        "p5 escrow-deposit usdc-treasury 12000000 -", // escrow funded (the price, not the 14.4 balance)
        "p5 usdc-treasury escrow-deposit 12000000 -", // proven mismatch: price back, never an expense
        "p5 usdc-treasury other-income-seller-forfeiture 2400000 -", // bond forfeited
      ].sort(),
    );
    expect(body.entries.filter((e: { purchaseId?: string; debitAccount: string }) => e.purchaseId === "p2" && e.debitAccount === "data-expense")).toEqual([]);

    const net = (account: string) => body.balances.find((b: { account: string }) => b.account === account).netAtomic;
    expect(net("usdc-treasury")).toBe(LEDGER_TREASURY.toString());
    expect(net("escrow-deposit")).toBe("0");
    expect(net("data-expense")).toBe("15000000");
    expect(net("owner-contribution")).toBe("-50000000");
    expect(net("other-income-seller-forfeiture")).toBe("-4800000");
    expect(body.departments.map((d: { department: string; netAtomic: string }) => [d.department, d.netAtomic])).toEqual([
      ["finance", "3600000"],
      ["research", "11400000"],
    ]);
  });

  it("journal filters by account and department; balances stay whole-book", async () => {
    const escrow = await json(await get("/api/ledger?account=escrow-deposit"));
    expect(escrow.entries).toHaveLength(7); // OrderFunded x3, PaidOut p1 x2, Refunded price rows x2
    expect(escrow.balances.find((b: { account: string }) => b.account === "usdc-treasury").netAtomic).toBe(LEDGER_TREASURY.toString());
    const finance = await json(await get("/api/ledger?department=finance"));
    expect(finance.entries.map(line)).toEqual(["p1 data-expense escrow-deposit 3600000 finance"]);
    const research = await json(await get("/api/ledger?account=data-expense&department=research"));
    expect(research.entries.map(line).sort()).toEqual(["p1 data-expense escrow-deposit 8400000 research", "p4 data-expense usdc-treasury 3000000 research"]);
    const newestFirst = await json(await get("/api/ledger?account=data-expense&limit=1"));
    expect(newestFirst.entries.map(line)).toEqual(["p4 data-expense usdc-treasury 3000000 research"]);
    expect((await get("/api/ledger?account=petty-cash")).status).toBe(400);
  });

  it("Fusion allocation breakdown: booked equals the planned share for every settled department line", async () => {
    const body = await json(await get("/api/ledger?limit=1"));
    expect(body.allocations).toEqual([
      { purchaseId: "p1", purchaseGroupId: null, department: "finance", allocatedAtomic: "3600000", bookedAtomic: "3600000" },
      { purchaseId: "p1", purchaseGroupId: null, department: "research", allocatedAtomic: "8400000", bookedAtomic: "8400000" },
      { purchaseId: "p4", purchaseGroupId: null, department: "research", allocatedAtomic: "3000000", bookedAtomic: "3000000" },
    ]);
  });

  it("reconciliation: no run yet, then a run with the chain matching the books shows zero differences and every escrow at zero", async () => {
    const before = await json(await get("/api/reconciliation"));
    expect(before.lastRun).toBeNull();
    expect(before.note).toMatch(/no reconciliation run/);

    r.source.setBalance(FIXTURE.usdc, FIXTURE.treasury, LEDGER_TREASURY);
    const res = await post("/api/reconciliation/run", {});
    expect(res.status).toBe(200);
    const { run } = await json(res);
    expect(run).toMatchObject({
      trigger: "api",
      blockNumber: "115",
      status: "ok",
      differences: [],
      exceptionIds: [],
      treasuryChainAtomic: LEDGER_TREASURY.toString(),
      treasuryLedgerAtomic: LEDGER_TREASURY.toString(),
      treasuryDifferenceAtomic: "0",
      escrowsChecked: 4,
      eventsChecked: 6, // PaidOut p1, Refunded p2, Refunded p5, Paid x3
      materialityAtomic: "10000",
    });
    expect(run.escrows.map((e: { purchaseId: string; status: string; open: boolean; ledgerAtomic: string; differenceAtomic: string; material: boolean }) => [e.purchaseId, e.status, e.open, e.ledgerAtomic, e.differenceAtomic, e.material]).sort()).toEqual([
      ["p1", "Settled", false, "0", "0", false],
      ["p2", "Refunded", false, "0", "0", false],
      ["p3", "Created", true, "0", "0", false],
      ["p5", "Refunded", false, "0", "0", false],
    ]);
    for (const e of run.escrows) expect(e.escrowAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const after = await json(await get("/api/reconciliation"));
    expect(after.lastRun.id).toBe(run.id);
    expect(after.openExceptions).toEqual([]);
    expect(after.note).toBeUndefined();
  });

  it("a planted 0.50 USDC difference opens one exception the controller decides; the requester may not", async () => {
    r.source.setBalance(FIXTURE.usdc, FIXTURE.treasury, LEDGER_TREASURY + 500_000n);
    const { run } = await json(await post("/api/reconciliation/run", {}));
    expect(run.status).toBe("differences");
    expect(run.differences).toHaveLength(1);
    expect(run.differences[0]).toMatchObject({ kind: "treasury", subject: "treasury", differenceAtomic: "500000", material: true });
    expect(run.exceptionIds).toHaveLength(1);
    const exceptionId: string = run.exceptionIds[0];

    const listed = await json(await get("/api/exceptions"));
    expect(listed.exceptions).toHaveLength(1);
    expect(listed.exceptions[0]).toMatchObject({
      id: exceptionId,
      type: "RECONCILIATION_DIFF",
      amountAtomic: "500000",
      subject: "treasury",
      status: "open",
      requestedBy: "system:reconciliation",
      request: null,
    });
    const recon = await json(await get("/api/reconciliation"));
    expect(recon.openExceptions.map((e: { id: string }) => e.id)).toEqual([exceptionId]);

    // Still planted: the open subject is not duplicated.
    const again = await json(await post("/api/reconciliation/run", {}));
    expect(again.run.exceptionIds).toEqual([]);

    const self = await post(`/api/exceptions/${exceptionId}/decide`, { decidedBy: "system:reconciliation", decision: "approve", reason: "x" });
    expect(self.status).toBe(403);
    expect((await json(self)).error.code).toBe("self_resolution");

    const decided = await post(`/api/exceptions/${exceptionId}/decide`, {
      decidedBy: "controller",
      decision: "approve",
      reason: "Chain wins on balances; ledger to be corrected with a new entry.",
    });
    expect(decided.status).toBe(200);
    const body = await json(decided);
    expect(body.exception).toMatchObject({ id: exceptionId, status: "resolved", decision: "approve", resolvedBy: "controller" });
    expect(body.request).toBeNull();

    const twice = await post(`/api/exceptions/${exceptionId}/decide`, { decidedBy: "controller", decision: "reject", reason: "again" });
    expect(twice.status).toBe(409);
    expect((await json(twice)).error.code).toBe("already_decided");

    expect((await json(await get("/api/exceptions"))).exceptions).toEqual([]);
    expect((await json(await get("/api/exceptions?status=resolved"))).exceptions.map((e: { id: string }) => e.id)).toEqual([exceptionId]);

    // The chain back in line with the books: ok again.
    r.source.setBalance(FIXTURE.usdc, FIXTURE.treasury, LEDGER_TREASURY);
    const ok = await json(await post("/api/reconciliation/run", {}));
    expect(ok.run.status).toBe("ok");
    expect(ok.run.differences).toEqual([]);
  });
});
