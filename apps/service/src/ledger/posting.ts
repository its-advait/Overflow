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
import { isKnownEscrow, purchaseForEscrow, waitingPurchaseForPayee } from "../chain/lookup.js";

// ---------------------------------------------------------------------------
// Journal posting rules (docs/SPEC.md "Journal entries (immediate-expense
// policy)"). One logical entry per chain event, keyed by
// eventKey = "<txHash>:<logIndex>"; a department split is one row per
// department sharing the eventKey. Idempotent: an event that already has rows
// posts nothing, and source_event_id is unique in the database.
//
//   Event                                  Debit                     Credit
//   USDC Transfer into the treasury        usdc-treasury             owner-contribution
//   USDC Transfer treasury -> escrow       escrow-deposit            usdc-treasury
//   PaidOut (delivery accepted)            data-expense / dept       escrow-deposit
//   Refunded (price part)                  usdc-treasury             escrow-deposit
//   Refunded (bond part)                   usdc-treasury             other-income-seller-forfeiture
//   Swept (late arrival recovered)         usdc-treasury             escrow-deposit
//   USDC Transfer out to a direct payee    data-expense / dept       usdc-treasury
//   Reserved, ReservationReleased, Paid, OrderFunded, transfers escrow -> treasury: no entry.
//
// The books follow the money: the deposit is booked when USDC leaves the
// treasury for an escrow (settle()'s Transfer), not when the escrow later
// reports OrderFunded (a status event whose balance includes the seller's
// bond, in a separate transaction from the payment).
//
// Nothing here moves money; it describes money the chain already moved.
// ---------------------------------------------------------------------------

export const UNALLOCATED_DEPARTMENT = "unallocated";

/** USDC the escrow sent back to the treasury in this transaction (the Transfer logs precede Refunded). */
async function returnedInTx(ctx: PostingContext, escrow: Address): Promise<bigint> {
  let total = 0n;
  for (const row of await ctx.repos.chainTransactions.listByTxHash(ctx.row.txHash)) {
    if (row.eventName !== "Transfer") continue;
    const from = row.args["from"];
    const to = row.args["to"];
    const value = row.args["value"];
    if (typeof from !== "string" || typeof to !== "string" || typeof value !== "string") continue;
    if (same(from, escrow) && same(to, ctx.treasury)) total += atomicToBigInt(value);
  }
  return total;
}

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
      // Money returning from an escrow is booked by Refunded (price + bond) or by the sweep reconciler.
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
      if (await isKnownEscrow(ctx.repos, to)) {
        // The treasury's USDC now sits in an escrow we know: a deposit, never an expense (that waits for PaidOut).
        const purchase = await purchaseForEscrow(ctx.repos, to);
        if (!purchase) ctx.warn(`USDC ${value} to escrow ${to} matches no purchase; deposit posted without a purchase id`);
        return [
          singleRow(ctx, {
            debit: "escrow-deposit",
            credit: "usdc-treasury",
            amount: value,
            memo: `Escrow ${to} funded by the treasury: ${value} atomic USDC${purchase ? ` (purchase ${purchase.id})` : " (no matching purchase)"}`,
            purchase,
          }),
        ];
      }
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

  async PaidOut(ctx) {
    const a = ctx.decoded.args;
    const escrow = ctx.row.contractAddress;
    const amount = atomicToBigInt(str(a, "amount"));
    const purchase = await purchaseForEscrow(ctx.repos, escrow);
    const deposit = purchase ? await ctx.repos.financialEntries.depositLineForPurchase(purchase.id) : 0n;
    if (deposit <= 0n) {
      // No funding on the books for this order: an expense here would leave escrow-deposit negative.
      ctx.warn(`PaidOut from escrow ${escrow} has no escrow deposit on the books; nothing posted (reconciliation will flag it)`);
      return [];
    }
    return splitRows(ctx, {
      debit: "data-expense",
      credit: "escrow-deposit",
      amount,
      memo: `Delivery accepted for escrow ${escrow}: ${amount} atomic USDC paid to seller ${str(a, "seller")}, bond ${str(a, "bond")} returned to the seller (purchase ${purchase!.id})`,
      purchase,
      allocations: purchase!.allocations,
    });
  },

  /**
   * The escrow's whole balance came back to the treasury in the Transfer that precedes Refunded in the same
   * transaction. The part that was our deposit reverses it; anything above it is the seller's forfeited bond.
   * A refund restores treasury USDC and never the agent's allowance; no expense.
   */
  async Refunded(ctx) {
    const a = ctx.decoded.args;
    const escrow = ctx.row.contractAddress;
    const reason = str(a, "reason") || "unspecified";
    const purchase = await purchaseForEscrow(ctx.repos, escrow);
    const deposit = purchase ? await ctx.repos.financialEntries.depositLineForPurchase(purchase.id) : 0n;
    const returned = await returnedInTx(ctx, escrow);
    if (deposit <= 0n && returned === 0n) {
      // Nothing of ours was in the escrow (never funded on our books) and nothing came back.
      ctx.warn(`Refunded from escrow ${escrow} (${reason}) with no deposit on the books and no USDC returned; nothing posted`);
      return [];
    }
    const price = returned === 0n ? deposit : returned < deposit ? returned : deposit;
    const bond = returned > deposit ? returned - deposit : 0n;
    if (returned === 0n) ctx.warn(`Refunded from escrow ${escrow}: no USDC Transfer back found in ${ctx.row.txHash}; reversing the booked deposit ${deposit}`);
    const eventKey = eventKeyOf(ctx.row);
    const rows: FinancialEntryInsert[] = [];
    if (price > 0n) {
      rows.push(
        singleRow(ctx, {
          debit: "usdc-treasury",
          credit: "escrow-deposit",
          amount: price,
          memo: `Refund from escrow ${escrow}: ${price} atomic USDC price returned to the treasury (${reason})${purchase ? ` (purchase ${purchase.id})` : ""}`,
          purchase,
        }),
      );
    }
    if (bond > 0n) {
      rows.push({
        ...singleRow(ctx, {
          debit: "usdc-treasury",
          credit: "other-income-seller-forfeiture",
          amount: bond,
          memo: `Seller bond forfeited on escrow ${escrow}: ${bond} atomic USDC to the treasury (${reason})${purchase ? ` (purchase ${purchase.id})` : ""}`,
          purchase,
        }),
        sourceEventId: `${eventKey}#bond`,
      });
    }
    return rows;
  },

  /** USDC that reached a closed order came back: reverse what the books still hold for it (a late deposit). */
  async Swept(ctx) {
    const a = ctx.decoded.args;
    const escrow = ctx.row.contractAddress;
    const amount = atomicToBigInt(str(a, "amount"));
    const purchase = await purchaseForEscrow(ctx.repos, escrow);
    const deposit = purchase ? await ctx.repos.financialEntries.depositLineForPurchase(purchase.id) : 0n;
    if (deposit <= 0n) {
      ctx.warn(`Swept ${amount} from escrow ${escrow} with no deposit on the books; nothing posted (reconciliation will flag the treasury difference)`);
      return [];
    }
    const reversed = amount < deposit ? amount : deposit;
    if (reversed < amount) ctx.warn(`Swept ${amount} from escrow ${escrow} exceeds the booked deposit ${deposit}; only the deposit is reversed`);
    return [
      singleRow(ctx, {
        debit: "usdc-treasury",
        credit: "escrow-deposit",
        amount: reversed,
        memo: `Sweep from closed escrow ${escrow}: ${reversed} atomic USDC returned to the treasury${purchase ? ` (purchase ${purchase.id})` : ""}`,
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
