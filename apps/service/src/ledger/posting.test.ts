import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE } from "../chain/fixtures/build-fixture.js";
import { eventKeyOf, postForLog, splitByDepartment, UNALLOCATED_DEPARTMENT } from "./posting.js";
import { replayFixture } from "./test-fixture.js";

describe("splitByDepartment", () => {
  const allocs = [
    { agentId: "a", department: "research", amountAtomic: "8400000" },
    { agentId: "b", department: "finance", amountAtomic: "3600000" },
    { agentId: "c", department: "research", amountAtomic: "0" },
  ];
  it("uses the allocations as-is when they add up to the amount", () => {
    expect(splitByDepartment(12_000_000n, allocs)).toEqual([
      { department: "research", amountAtomic: 8_400_000n },
      { department: "finance", amountAtomic: 3_600_000n },
    ]);
  });
  it("scales with integer math and keeps the total unchanged", () => {
    const lines = splitByDepartment(10_000_001n, allocs);
    expect(lines.reduce((s, l) => s + l.amountAtomic, 0n)).toBe(10_000_001n);
    expect(lines[0]!.amountAtomic).toBe(7_000_000n); // floor(10000001 * 0.7)
    expect(lines[1]!.amountAtomic).toBe(3_000_001n); // remainder on the last line
  });
  it("books one unallocated line without allocations", () => {
    expect(splitByDepartment(5n, [])).toEqual([{ department: UNALLOCATED_DEPARTMENT, amountAtomic: 5n }]);
  });
});

describe("posting rules (SIMULATED fixture replay)", () => {
  let r: Awaited<ReturnType<typeof replayFixture>>;
  beforeAll(async () => {
    r = await replayFixture();
  });
  afterAll(() => r.handle.close());

  const byEvent = async (txNo: number, logIndex: number) =>
    r.handle.repos.financialEntries.listByEventKey(`0x${"f".repeat(60)}${txNo.toString(16).padStart(4, "0")}:${logIndex}`);

  it("treasury funded: USDC Transfer in -> Dr usdc-treasury / Cr owner-contribution", async () => {
    const [e, ...rest] = await byEvent(20, 0);
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ debitAccount: "usdc-treasury", creditAccount: "owner-contribution", amountAtomic: FIXTURE.funding, purchaseId: undefined });
  });

  it("escrow funded (both payment paths): Dr escrow-deposit / Cr usdc-treasury; the Transfer and Paid post nothing", async () => {
    // The deposit is booked when the treasury's USDC moves (settle()'s Transfer), on both facilitator paths.
    expect((await byEvent(4, 0))[0]).toMatchObject({ debitAccount: "escrow-deposit", creditAccount: "usdc-treasury", amountAtomic: FIXTURE.amount, purchaseId: "p1" });
    expect((await byEvent(8, 0))[0]).toMatchObject({ debitAccount: "escrow-deposit", creditAccount: "usdc-treasury", amountAtomic: FIXTURE.amount, purchaseId: "p2" });
    expect(await byEvent(4, 1)).toEqual([]); // Paid
    expect(await byEvent(4, 2)).toEqual([]); // OrderFunded: status only (its balance includes the seller's bond)
    expect(await byEvent(8, 1)).toEqual([]); // OrderFunded on the coinbase path
  });

  it("delivery accepted: expense split by Fusion allocations across departments, total unchanged", async () => {
    const lines = await byEvent(6, 1);
    expect(lines.map((l) => [l.department, l.amountAtomic, l.debitAccount, l.creditAccount]).sort()).toEqual([
      ["finance", "3600000", "data-expense", "escrow-deposit"],
      ["research", "8400000", "data-expense", "escrow-deposit"],
    ].sort());
    expect(lines.every((l) => l.purchaseId === "p1")).toBe(true);
    expect(new Set(lines.map((l) => l.sourceEventId)).size).toBe(2);
  });

  it("timeout refund reverses the deposit and leaves no expense; the bond is other income (both rows from one Refunded)", async () => {
    const rows = await byEvent(9, 1);
    expect(rows.map((e) => [e.debitAccount, e.creditAccount, e.amountAtomic, e.purchaseId, e.sourceEventId.endsWith("#bond")]).sort()).toEqual([
      ["usdc-treasury", "escrow-deposit", FIXTURE.amount, "p2", false],
      ["usdc-treasury", "other-income-seller-forfeiture", FIXTURE.bond, "p2", true],
    ]);
    expect(await byEvent(9, 0)).toEqual([]); // the USDC transfer back (price + bond in one) posts nothing
    const p2 = await r.handle.repos.financialEntries.listForPurchase("p2");
    expect(p2.some((e) => e.debitAccount === "data-expense" || e.creditAccount === "data-expense")).toBe(false);
    expect(await r.handle.repos.financialEntries.depositLineForPurchase("p2")).toBe(0n);
  });

  it("a proven mismatch books like a timeout: deposit reversed, bond (returned balance minus deposit) forfeited, no expense", async () => {
    expect((await byEvent(17, 1))[0]).toMatchObject({ debitAccount: "escrow-deposit", creditAccount: "usdc-treasury", amountAtomic: FIXTURE.amount, purchaseId: "p5" }); // the price; OrderFunded's 14.4 balance posts nothing
    expect(await byEvent(17, 3)).toEqual([]);
    const rows = await byEvent(19, 3);
    expect(rows.map((e) => [e.creditAccount, e.amountAtomic]).sort()).toEqual([["escrow-deposit", FIXTURE.amount], ["other-income-seller-forfeiture", FIXTURE.bond]]);
    expect(await byEvent(19, 0)).toEqual([]); // CheatProven
    expect(await byEvent(19, 1)).toEqual([]); // CheatRecorded
    expect(await byEvent(19, 2)).toEqual([]); // Transfer back
    expect(await r.handle.repos.financialEntries.depositLineForPurchase("p5")).toBe(0n);
  });

  it("direct x402 purchase: Dr data-expense (department) / Cr usdc-treasury from the USDC Transfer; Paid posts nothing", async () => {
    const [e, ...rest] = await byEvent(15, 0);
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ debitAccount: "data-expense", creditAccount: "usdc-treasury", amountAtomic: FIXTURE.apiAmount, department: "research", purchaseId: "p4" });
    expect(await byEvent(15, 1)).toEqual([]);
  });

  it("reservations and a PaidOut with no deposit on the books post nothing", async () => {
    expect(await byEvent(7, 1)).toEqual([]); // Reserved
    expect(await byEvent(12, 3)).toEqual([]); // ReservationReleased
    expect(await byEvent(13, 1)).toEqual([]); // PaidOut for order 3, never funded
    expect(r.warnings.some((w) => w.includes("PaidOut") && w.includes("no escrow deposit"))).toBe(true);
  });

  it("debits equal credits for every entry and across the books", async () => {
    const all = await r.handle.repos.financialEntries.listAll();
    expect(all.length).toBe(11);
    for (const e of all) expect(e.debitAccount).not.toBe(e.creditAccount); // one debit and one credit of the same amount per row
    const balances = await r.handle.repos.financialEntries.balances();
    const trial = balances.reduce((s, b) => s + b.debitsAtomic - b.creditsAtomic, 0n);
    expect(trial).toBe(0n);
    const net = Object.fromEntries(balances.map((b) => [b.account, (b.debitsAtomic - b.creditsAtomic).toString()]));
    expect(net).toEqual({
      "usdc-treasury": "39800000",
      "escrow-deposit": "0",
      "data-expense": "15000000",
      "owner-contribution": "-50000000",
      "other-income-seller-forfeiture": "-4800000",
    });
    const depts = await r.handle.repos.financialEntries.departmentBalances();
    expect(depts.map((d) => [d.department, d.account, d.debitsAtomic.toString()])).toEqual([
      ["finance", "data-expense", "3600000"],
      ["research", "data-expense", "11400000"],
    ]);
  });

  it("replaying events does not double-post", async () => {
    const before = (await r.handle.repos.financialEntries.listAll()).length;
    const again = await r.indexer.tick();
    expect(again.logsInserted).toBe(0);
    expect(again.entries).toEqual([]);
    // Calling the rule directly for an already-booked event is also a no-op.
    const row = (await r.handle.repos.chainTransactions.listByEvent("Transfer")).find((x) => String(x.args["to"]).toLowerCase() === FIXTURE.escrow1)!;
    const posted = await postForLog({
      repos: r.handle.repos,
      row,
      decoded: { kind: "usdc", eventName: "Transfer", args: row.args as Record<string, string>, log: r.source.logs[0]! },
      treasury: FIXTURE.treasury,
      warn: () => undefined,
    });
    expect(posted).toEqual([]);
    expect(eventKeyOf(row)).toBe(`${row.txHash}:${row.logIndex}`);
    expect((await r.handle.repos.financialEntries.listAll()).length).toBe(before);
  });
});
