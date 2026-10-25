import type { FinancialEntryInsert, Repositories } from "@overflow/database";
import {
  atomicToBigInt,
  type Address,
  type Allocation,
  type ChainTransaction,
  type FinancialEntry,
  type LedgerAccount,
  type PurchaseRecord,
} from "@overflow/schemas";
import type { DecodedLog, JsonArgs } from "../chain/decode.js";
import { isKnownEscrow, orderCreatedFor, purchaseForOrder, waitingPurchaseForPayee } from "../chain/lookup.js";

// ---------------------------------------------------------------------------
// Journal posting rules (docs/SPEC.md "Journal entries (immediate-expense
// policy)"). One logical entry per chain event, keyed by
// eventKey = "<txHash>:<logIndex>"; a department split is one row per
// department sharing the eventKey. Idempotent: an event that already has rows
// posts nothing, and source_event_id is unique in the database.
//
//   Event                                  Debit                     Credit
//   USDC Transfer into the treasury        usdc-treasury             owner-contribution
//   OrderFunded                            escrow-deposit            usdc-treasury
//   PaidOut (delivery accepted)            data-expense / dept       escrow-deposit
//   Refunded (timeout or proven cheat)     usdc-treasury             escrow-deposit
//   BondForfeited                          usdc-treasury             other-income-seller-forfeiture
//   USDC Transfer out to a direct payee    data-expense / dept       usdc-treasury
//   Reserved, ReservationReleased, Paid, transfers to/from an escrow: no entry.
//
// Nothing here moves money; it describes money the chain already moved.
// ---------------------------------------------------------------------------

export const UNALLOCATED_DEPARTMENT = "unallocated";

export interface PostingContext {
  repos: Repositories;
  row: ChainTransaction;
  decoded: DecodedLog;
  treasury: Address;
  warn: (message: string) => void;
}

export interface DepartmentLine {
  department: string;
  amountAtomic: bigint;
}

export const eventKeyOf = (row: Pick<ChainTransaction, "txHash" | "logIndex">): string => `${row.txHash.toLowerCase()}:${row.logIndex}`;

const str = (args: JsonArgs, key: string): string => String(args[key] ?? "");
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Splits `amount` across departments in proportion to the purchase's Fusion
 * allocations (summed per department, first-seen order). The lines always add
 * up to `amount`: integer division, remainder on the last line. No allocations
 * or a zero total books one "unallocated" line.
 */
export function splitByDepartment(amount: bigint, allocations: readonly Allocation[]): DepartmentLine[] {
  if (amount < 0n) throw new RangeError("amount must not be negative");
  const perDept = new Map<string, bigint>();
  for (const a of allocations) perDept.set(a.department, (perDept.get(a.department) ?? 0n) + atomicToBigInt(a.amountAtomic));
  const total = [...perDept.values()].reduce((s, v) => s + v, 0n);
  if (perDept.size === 0 || total === 0n) return [{ department: UNALLOCATED_DEPARTMENT, amountAtomic: amount }];
  if (total === amount) return [...perDept].map(([department, amountAtomic]) => ({ department, amountAtomic }));
  const lines: DepartmentLine[] = [];
  let assigned = 0n;
  const entries = [...perDept];
  entries.forEach(([department, share], i) => {
    const amountAtomic = i === entries.length - 1 ? amount - assigned : (amount * share) / total;
    assigned += amountAtomic;
    lines.push({ department, amountAtomic });
  });
  return lines.filter((l) => l.amountAtomic > 0n || lines.length === 1);
}

interface Single {
  debit: LedgerAccount;
  credit: LedgerAccount;
  amount: bigint;
  memo: string;
  purchase?: PurchaseRecord | undefined;
}

interface Split {
  debit: LedgerAccount;
  credit: LedgerAccount;
  amount: bigint;
  memo: string;
  purchase: PurchaseRecord | undefined;
  allocations: readonly Allocation[];
}

function singleRow(ctx: PostingContext, s: Single): FinancialEntryInsert {
  const eventKey = eventKeyOf(ctx.row);
  return {
    debitAccount: s.debit,
    creditAccount: s.credit,
    amountAtomic: s.amount.toString(),
    memo: s.memo,
    eventKey,
    sourceEventId: eventKey,
    txHash: ctx.row.txHash,
    ...(s.purchase ? { purchaseId: s.purchase.id } : {}),
  };
}

function splitRows(ctx: PostingContext, s: Split): FinancialEntryInsert[] {
  const eventKey = eventKeyOf(ctx.row);
  return splitByDepartment(s.amount, s.allocations).map((line) => ({
    debitAccount: s.debit,
    creditAccount: s.credit,
    amountAtomic: line.amountAtomic.toString(),
    memo: `${s.memo} [${line.department} ${line.amountAtomic}]`,
    eventKey,
    sourceEventId: `${eventKey}#${line.department}`,
    department: line.department,
    txHash: ctx.row.txHash,
    ...(s.purchase ? { purchaseId: s.purchase.id } : {}),
  }));
}

type Rule = (ctx: PostingContext) => Promise<FinancialEntryInsert[]>;

const rules: Record<string, Rule> = {
  async Transfer(ctx) {
    const a = ctx.decoded.args;
    const from = str(a, "from") as Address;
    const to = str(a, "to") as Address;
    const value = atomicToBigInt(str(a, "value"));
    if (same(to, ctx.treasury) && !same(from, ctx.treasury)) {
      // Money returning from an escrow is booked by Refunded / BondForfeited.
      if (await isKnownEscrow(ctx.repos, from)) return [];
      return [
        singleRow(ctx, {
          debit: "usdc-treasury",
          credit: "owner-contribution",
          amount: value,
          memo: `Treasury funded: ${value} atomic USDC received from ${from}`,
        }),
      ];
    }
    if (same(from, ctx.treasury) && !same(to, ctx.treasury)) {
      // Escrow funding is booked by the escrow's OrderFunded.
      if (await isKnownEscrow(ctx.repos, to)) return [];
      const purchase = await waitingPurchaseForPayee(ctx.repos, to);
      if (!purchase) {
        ctx.warn(`USDC outflow ${value} to ${to} matches no purchase; nothing posted (reconciliation will flag the treasury difference)`);
        return [];
      }
      return splitRows(ctx, {
        debit: "data-expense",
        credit: "usdc-treasury",
        amount: value,
        memo: `Direct x402 purchase ${purchase.id}: ${value} atomic USDC paid to ${to}`,
        purchase,
        allocations: purchase.allocations,
      });
    }
    return [];
  },

  async OrderFunded(ctx) {
    const a = ctx.decoded.args;
    const orderId = str(a, "orderId");
    const amount = atomicToBigInt(str(a, "amount"));
    const created = await orderCreatedFor(ctx.repos, orderId);
    if (created && typeof created.args["buyer"] === "string" && !same(created.args["buyer"], ctx.treasury)) {
      ctx.warn(`OrderFunded for order ${orderId} has buyer ${created.args["buyer"]}, not the treasury; nothing posted`);
      return [];
    }
    const purchase = await purchaseForOrder(ctx.repos, orderId);
    if (!purchase) ctx.warn(`OrderFunded for order ${orderId} matches no purchase; posted without a purchase id`);
    return [
      singleRow(ctx, {
        debit: "escrow-deposit",
        credit: "usdc-treasury",
        amount,
        memo: `Escrow funded for order ${orderId}: ${amount} atomic USDC${purchase ? ` (purchase ${purchase.id})` : " (no matching purchase)"}`,
        purchase,
      }),
    ];
  },

  async PaidOut(ctx) {
    const a = ctx.decoded.args;
    const orderId = str(a, "orderId");
    const amount = atomicToBigInt(str(a, "amount"));
    const purchase = await purchaseForOrder(ctx.repos, orderId);
    const deposit = purchase ? await ctx.repos.financialEntries.depositLineForPurchase(purchase.id) : 0n;
    if (deposit <= 0n) {
      // No funding on the books for this order: an expense here would leave escrow-deposit negative.
      ctx.warn(`PaidOut for order ${orderId} has no escrow deposit on the books; nothing posted (reconciliation will flag it)`);
      return [];
    }
    return splitRows(ctx, {
      debit: "data-expense",
      credit: "escrow-deposit",
      amount,
      memo: `Delivery accepted for order ${orderId}: ${amount} atomic USDC paid to seller ${str(a, "seller")} (purchase ${purchase!.id})`,
      purchase,
      allocations: purchase!.allocations,
    });
  },

  async Refunded(ctx) {
    const a = ctx.decoded.args;
    const orderId = str(a, "orderId");
    const amount = atomicToBigInt(str(a, "amount"));
    const purchase = await purchaseForOrder(ctx.repos, orderId);
    // Reverses the deposit. A refund restores treasury USDC; it never restores the agent's allowance, and no expense is ever posted.
    return [
      singleRow(ctx, {
        debit: "usdc-treasury",
        credit: "escrow-deposit",
        amount,
        memo: `Refund for order ${orderId}: ${amount} atomic USDC returned to the treasury (${str(a, "reason") || "unspecified"})${purchase ? ` (purchase ${purchase.id})` : " (no matching purchase)"}`,
        purchase,
      }),
    ];
  },

  async BondForfeited(ctx) {
    const a = ctx.decoded.args;
    const orderId = str(a, "orderId");
    const bond = atomicToBigInt(str(a, "bond"));
    const purchase = await purchaseForOrder(ctx.repos, orderId);
    return [
      singleRow(ctx, {
        debit: "usdc-treasury",
        credit: "other-income-seller-forfeiture",
        amount: bond,
        memo: `Seller bond forfeited for order ${orderId}: ${bond} atomic USDC from seller ${str(a, "seller")}${purchase ? ` (purchase ${purchase.id})` : ""}`,
        purchase,
      }),
    ];
  },
};

/** Event names that post an entry; everything else is memo-only. */
export const POSTING_EVENTS: readonly string[] = Object.keys(rules);

/**
 * Posts the journal rows for one recorded chain event. Returns [] when the
 * event has no rule, posts nothing by rule, or already has rows (replay).
 * Every row is one debit and one credit of the same amount, so debits equal
 * credits by construction; a split's rows add up to the event amount.
 */
export async function postForLog(ctx: PostingContext): Promise<FinancialEntry[]> {
  const rule = rules[ctx.decoded.eventName];
  if (!rule) return [];
  const eventKey = eventKeyOf(ctx.row);
  if ((await ctx.repos.financialEntries.listByEventKey(eventKey)).length > 0) return [];
  const rows = await rule(ctx);
  const posted: FinancialEntry[] = [];
  for (const row of rows) posted.push(await ctx.repos.financialEntries.post(row));
  return posted;
}
