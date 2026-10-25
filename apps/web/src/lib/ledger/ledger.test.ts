import { describe, expect, it } from "vitest";
import * as fx from "../mocks/fixtures";
import { ACCOUNT_STYLE, entryKind, normalBalance, trialBalance } from "./accounts";
import { bps, byDepartment, byPurchase, formatBps } from "./allocations";
import { decideOptions } from "./exceptions";
import { departmentsOf, filterEntries, isSplitLine, newestFirst } from "./journal";
import { exceptionFor, isMaterial, materialRows, reconciliationRows } from "./reconciliation";

const sum = (entries: typeof fx.ledgerEntries) => {
  const m = new Map<string, { debits: bigint; credits: bigint }>();
  for (const e of entries) {
    const v = BigInt(e.amountAtomic);
    const d = m.get(e.debitAccount) ?? { debits: 0n, credits: 0n };
    d.debits += v;
    m.set(e.debitAccount, d);
    const c = m.get(e.creditAccount) ?? { debits: 0n, credits: 0n };
    c.credits += v;
    m.set(e.creditAccount, c);
  }
  return [...m.entries()].map(([account, s]) => ({
    account: account as keyof typeof ACCOUNT_STYLE,
    debitsAtomic: s.debits.toString(),
    creditsAtomic: s.credits.toString(),
    netAtomic: (s.debits - s.credits).toString(),
  }));
};

describe("accounts", () => {
  it("the fixture books trial-balance and credit-normal accounts read positive on their normal side", () => {
    const balances = sum(fx.ledgerEntries);
    const tb = trialBalance(balances);
    expect(tb.balanced).toBe(true);
    expect(tb.debitsAtomic).toBe(tb.creditsAtomic);
    const owner = balances.find((b) => b.account === "owner-contribution")!;
    expect(BigInt(owner.netAtomic) < 0n).toBe(true);
    expect(normalBalance(owner)).toBe(250_000_000n);
    expect(normalBalance(balances.find((b) => b.account === "usdc-treasury")!)).toBe(225_500_000n);
  });
  it("labels the spec's journal rows and keeps funding, settlement and refund apart", () => {
    expect(entryKind({ debitAccount: "escrow-deposit", creditAccount: "usdc-treasury" })).toMatchObject({ phase: "escrow-funding", tone: "cyan" });
    expect(entryKind({ debitAccount: "data-expense", creditAccount: "escrow-deposit" })).toMatchObject({ phase: "settlement", tone: "success" });
    expect(entryKind({ debitAccount: "usdc-treasury", creditAccount: "escrow-deposit" })).toMatchObject({ phase: "refund", tone: "warning" });
    expect(entryKind({ debitAccount: "usdc-treasury", creditAccount: "other-income-seller-forfeiture" }).phase).toBe("forfeiture");
    expect(entryKind({ debitAccount: "data-expense", creditAccount: "usdc-treasury" }).phase).toBe("direct-purchase");
    expect(entryKind({ debitAccount: "usdc-treasury", creditAccount: "owner-contribution" }).phase).toBe("funding");
  });
});

describe("journal", () => {
  it("filters by account (either side) and department like the service", () => {
    expect(filterEntries(fx.ledgerEntries, { account: "escrow-deposit" })).toHaveLength(7);
    expect(filterEntries(fx.ledgerEntries, { department: "finance" }).map((e) => e.id)).toEqual(["fe-merged-expense-finance"]);
    expect(filterEntries(fx.ledgerEntries, { account: "data-expense", department: "research" }).map((e) => e.id)).toEqual(["fe-merged-expense-research"]);
    expect(filterEntries(fx.ledgerEntries, { purchaseId: "pur-freight-weekly" })).toHaveLength(2);
    expect(filterEntries(fx.ledgerEntries, {})).toHaveLength(fx.ledgerEntries.length);
  });
  it("lists departments, marks split lines and sorts newest first", () => {
    expect(departmentsOf(fx.ledgerEntries)).toEqual(["finance", "research"]);
    expect(isSplitLine(fx.ledgerEntries.find((e) => e.id === "fe-merged-expense-finance")!)).toBe(true);
    expect(isSplitLine(fx.ledgerEntries.find((e) => e.id === "fe-owner-funding")!)).toBe(false);
    const sorted = newestFirst(fx.ledgerEntries);
    expect(sorted[0]!.postedAt >= sorted.at(-1)!.postedAt).toBe(true);
  });
});

describe("allocations", () => {
  const rows = [
    { purchaseId: "pur-merged-national", purchaseGroupId: "pg-1", department: "finance", allocatedAtomic: "8181818", bookedAtomic: "8181818" },
    { purchaseId: "pur-merged-national", purchaseGroupId: "pg-1", department: "research", allocatedAtomic: "3818182", bookedAtomic: "3818182" },
    { purchaseId: "pur-weather-daily", purchaseGroupId: null, department: "research", allocatedAtomic: "4500000", bookedAtomic: "0" },
  ];
  it("groups by purchase with integer shares that sum to the one onchain transfer", () => {
    const [merged, weather] = byPurchase(rows);
    expect(merged).toMatchObject({ merged: true, bookedAtomic: 12_000_000n, allocatedAtomic: 12_000_000n });
    expect(merged!.lines.map((l) => [l.department, formatBps(l.shareBps), l.matches])).toEqual([
      ["finance", "68.18%", true],
      ["research", "31.81%", true],
    ]);
    expect(merged!.lines.reduce((s, l) => s + l.bookedAtomic, 0n)).toBe(12_000_000n);
    // Still in escrow: nothing expensed yet, which is not a mismatch.
    expect(weather).toMatchObject({ merged: false, bookedAtomic: 0n, allocatedAtomic: 4_500_000n });
    expect(weather!.lines[0]!.matches).toBe(true);
  });
  it("a booked line that differs from its plan is a mismatch; by department only counts booked expense", () => {
    const off = byPurchase([{ ...rows[0]!, bookedAtomic: "8000000" }]);
    expect(off[0]!.lines[0]!.matches).toBe(false);
    expect(byDepartment(rows).map((d) => [d.department, d.bookedAtomic.toString(), d.purchases.length])).toEqual([
      ["finance", "8181818", 1],
      ["research", "3818182", 1],
    ]);
    expect(bps(1n, 0n)).toBe(0n);
  });
});

describe("reconciliation", () => {
  it("an ok run: treasury and every escrow at zero, nothing material, no exception", () => {
    const rows = reconciliationRows(fx.reconciliationRun);
    expect(rows).toHaveLength(1 + fx.escrows.length);
    expect(rows[0]).toMatchObject({ kind: "treasury", subject: "treasury", differenceAtomic: 0n, material: false });
    for (const r of rows) expect(r.differenceAtomic).toBe(0n);
    // Open orders first.
    expect(rows.slice(1, 4).every((r) => r.open)).toBe(true);
    expect(rows.slice(4).every((r) => !r.open)).toBe(true);
    expect(materialRows(rows)).toEqual([]);
    expect(exceptionFor(rows[0]!, [fx.exception])).toBeUndefined();
  });
  it("the planted run: one material treasury difference of 0.50 USDC linked to its open exception", () => {
    const rows = reconciliationRows(fx.reconciliationRunPlanted);
    const material = materialRows(rows);
    expect(material).toHaveLength(1);
    expect(material[0]).toMatchObject({ kind: "treasury", chainAtomic: 226_000_000n, ledgerAtomic: 225_500_000n, differenceAtomic: 500_000n });
    expect(exceptionFor(material[0]!, [fx.exception, fx.plantedException])?.id).toBe(fx.plantedException.id);
    expect(exceptionFor(material[0]!, [{ ...fx.plantedException, status: "resolved" }])).toBeUndefined();
  });
  it("materiality is strict: 0.01 USDC is not material, 0.010001 is, sign ignored", () => {
    expect(isMaterial(10_000n, 10_000n)).toBe(false);
    expect(isMaterial(10_001n, 10_000n)).toBe(true);
    expect(isMaterial(-10_001n, 10_000n)).toBe(true);
  });
});

describe("exceptions", () => {
  it("onchain types can only be rejected; offchain ones take either decision; nobody decides their own", () => {
    const pause = decideOptions(fx.exception, "controller");
    expect(pause.approve.enabled).toBe(false);
    expect(pause.approve.reason).toMatch(/Coinbase Wallet/);
    expect(pause.reject.enabled).toBe(true);
    const recon = decideOptions(fx.plantedException, "controller");
    expect(recon).toEqual({ approve: { enabled: true }, reject: { enabled: true } });
    const self = decideOptions(fx.plantedException, "system:reconciliation");
    expect(self.approve.enabled).toBe(false);
    expect(self.reject.reason).toMatch(/cannot decide/);
    const done = decideOptions({ ...fx.plantedException, status: "resolved" }, "controller");
    expect(done.approve).toEqual({ enabled: false, reason: "already resolved" });
  });
});
