import { createRepositories, type Db } from "@overflow/database";
import {
  atomicToBigInt,
  DEFAULT_MATERIALITY_ATOMIC,
  ReconciliationRunSchema,
  type ActivityEvent,
  type Address,
  type ChainTransaction,
  type ReconciliationDifference,
  type ReconciliationEscrowCheck,
  type ReconciliationRun,
  type ReconciliationTrigger,
} from "@overflow/schemas";
import type { ActivityBus } from "../chain/bus.js";
import type { BalanceReader, LogSource } from "../chain/log-source.js";
import { DEFAULT_CURSOR_NAME } from "../chain/indexer.js";
import { eventKeyOf } from "./posting.js";

// ---------------------------------------------------------------------------
// Reconciliation (docs/SPEC.md "Reconciliation"). The chain is the bank, the
// ledger is the books. A run reads balances at the indexer's cursor block and
// checks:
//   1. USDC balanceOf(treasury) == net of the usdc-treasury account,
//   2. each open escrow's balance (minus the seller's bond) == that order's
//      escrow-deposit line; closed orders net to zero,
//   3. every confirmed PaidOut and Refunded has exactly one entry; every Paid
//      has exactly one entry in its transaction.
// A difference above materiality (default 0.01 USDC), or any missing entry,
// opens an exception for the controller. The ledger is never silently edited.
// ---------------------------------------------------------------------------

export interface ReconciliationDeps {
  db: Db;
  reader: BalanceReader & Pick<LogSource, "getBlockNumber">;
  treasury: Address;
  usdc: Address;
  /** Differences at or below this are immaterial. Default 10000 (0.01 USDC). */
  materialityAtomic?: bigint | undefined;
  bus?: ActivityBus | undefined;
  cursorName?: string | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface Reconciliation {
  run(trigger: ReconciliationTrigger, blockNumber?: bigint): Promise<ReconciliationRun>;
  latest(): Promise<ReconciliationRun | undefined>;
}

export const EXCEPTION_TYPE = "RECONCILIATION_DIFF" as const;
/** Reconciliation raises on behalf of the system, so any human may decide. */
export const RECONCILIATION_PRINCIPAL = "system:reconciliation" as const;

const abs = (v: bigint): bigint => (v < 0n ? -v : v);
const arg = (row: ChainTransaction, key: string): string => String(row.args[key] ?? "");

export function createReconciliation(deps: ReconciliationDeps): Reconciliation {
  const materiality = deps.materialityAtomic ?? atomicToBigInt(DEFAULT_MATERIALITY_ATOMIC);
  const cursorName = deps.cursorName ?? DEFAULT_CURSOR_NAME;
  const log = deps.log ?? ((m: string) => console.log(`[ledger] ${m}`));
  const material = (difference: bigint): boolean => abs(difference) > materiality;

  async function run(trigger: ReconciliationTrigger, blockNumber?: bigint): Promise<ReconciliationRun> {
    const repos = createRepositories(deps.db);
    const cursor = await repos.indexerCursors.get(cursorName);
    const block = blockNumber ?? (cursor ? BigInt(cursor.lastBlock) : await deps.reader.getBlockNumber());
    const differences: ReconciliationDifference[] = [];

    // 1. Treasury.
    const chainTreasury = await deps.reader.balanceOf(deps.usdc, deps.treasury, block);
    const t = await repos.financialEntries.balance("usdc-treasury");
    const ledgerTreasury = t.debitsAtomic - t.creditsAtomic;
    const treasuryDiff = chainTreasury - ledgerTreasury;
    if (treasuryDiff !== 0n) {
      differences.push({
        kind: "treasury",
        subject: "treasury",
        reason: `treasury USDC: chain ${chainTreasury} vs ledger ${ledgerTreasury} at block ${block} (difference ${treasuryDiff})`,
        chainAtomic: chainTreasury.toString(),
        ledgerAtomic: ledgerTreasury.toString(),
        differenceAtomic: treasuryDiff.toString(),
        material: material(treasuryDiff),
      });
    }

    // 2. Escrows: one check per order, recorded whether or not it matches.
    const orders = await repos.escrowOrders.listAll();
    const escrows: ReconciliationEscrowCheck[] = [];
    for (const order of orders) {
      const line = await repos.financialEntries.depositLineForPurchase(order.purchaseId);
      const open = order.status === "Created" || order.status === "Funded" || order.status === "Revealed";
      let chain: bigint | undefined;
      let expected: bigint;
      let note: string;
      if (!open) {
        expected = 0n;
        note = `closed (${order.status}) order must net to zero`;
      } else if (order.status === "Created") {
        expected = 0n;
        note = "unfunded order holds nothing of the treasury's";
      } else {
        chain = await deps.reader.balanceOf(deps.usdc, order.escrowAddress, block);
        expected = chain - atomicToBigInt(order.bondAtomic);
        note = `escrow ${order.escrowAddress} holds ${chain} (bond ${order.bondAtomic}) at block ${block}`;
      }
      const diff = expected - line;
      escrows.push({
        purchaseId: order.purchaseId,
        escrowAddress: order.escrowAddress,
        status: order.status,
        open,
        ...(chain !== undefined ? { chainAtomic: chain.toString() } : {}),
        bondAtomic: order.bondAtomic,
        expectedAtomic: expected.toString(),
        ledgerAtomic: line.toString(),
        differenceAtomic: diff.toString(),
        material: diff !== 0n && material(diff),
      });
      if (diff !== 0n) {
        differences.push({
          kind: "escrow",
          subject: `escrow:${order.purchaseId}`,
          reason: `escrow deposit for purchase ${order.purchaseId}: ${note}; ledger line ${line} (difference ${diff})`,
          ...(chain !== undefined ? { chainAtomic: chain.toString() } : {}),
          ledgerAtomic: line.toString(),
          differenceAtomic: diff.toString(),
          purchaseId: order.purchaseId,
          material: material(diff),
        });
      }
    }

    // 3. Event coverage.
    let eventsChecked = 0;
    for (const name of ["PaidOut", "Refunded"] as const) {
      for (const row of await repos.chainTransactions.listByEvent(name)) {
        if (!row.confirmed) continue;
        eventsChecked++;
        const key = eventKeyOf(row);
        if ((await repos.financialEntries.listByEventKey(key)).length === 0) {
          differences.push({
            kind: "event-coverage",
            subject: `event:${key}`,
            reason: `${name} ${key} (order ${arg(row, "orderId")}, ${arg(row, "amount")} atomic USDC) has no journal entry`,
            differenceAtomic: arg(row, "amount") || "0",
            eventKey: key,
            ...(row.purchaseId ? { purchaseId: row.purchaseId } : {}),
            material: true,
          });
        }
      }
    }
    for (const row of await repos.chainTransactions.listByEvent("Paid")) {
      if (!row.confirmed) continue;
      eventsChecked++;
      const groups = new Set((await repos.financialEntries.listByTxHash(row.txHash)).map((e) => e.eventKey));
      if (groups.size !== 1) {
        const key = eventKeyOf(row);
        differences.push({
          kind: "event-coverage",
          subject: `event:${key}`,
          reason: `Paid ${key} (${arg(row, "value")} atomic USDC to ${arg(row, "to")}) has ${groups.size} journal entries in its transaction, expected exactly one`,
          differenceAtomic: arg(row, "value") || "0",
          eventKey: key,
          ...(row.purchaseId ? { purchaseId: row.purchaseId } : {}),
          material: true,
        });
      }
    }

    // 4. Exceptions and the run record, one transaction.
    const { saved, events } = await deps.db.transaction(async (tx) => {
      const r = createRepositories(tx);
      const exceptionIds: string[] = [];
      const events: ActivityEvent[] = [];
      for (const d of differences) {
        if (!d.material) continue;
        if (await r.exceptions.findOpenBySubject(EXCEPTION_TYPE, d.subject)) continue; // already waiting on the controller
        const ex = await r.exceptions.open({
          type: EXCEPTION_TYPE,
          reason: d.reason,
          amountAtomic: abs(atomicToBigInt(d.differenceAtomic.replace(/^-/, ""))).toString(),
          subject: d.subject,
          requestedBy: RECONCILIATION_PRINCIPAL,
          details: { kind: d.kind, ...(d.chainAtomic ? { chainAtomic: d.chainAtomic } : {}), ...(d.ledgerAtomic ? { ledgerAtomic: d.ledgerAtomic } : {}), differenceAtomic: d.differenceAtomic },
          ...(d.purchaseId ? { purchaseId: d.purchaseId } : {}),
        });
        exceptionIds.push(ex.id);
        events.push(
          await r.activityEvents.insert({
            kind: "exception.opened",
            message: `reconciliation exception ${ex.id}: ${d.reason} [reconciliation:${trigger}]`,
            ...(d.purchaseId ? { purchaseId: d.purchaseId } : {}),
            simulated: false,
          }),
        );
      }
      const saved = await r.reconciliationRuns.insert(
        ReconciliationRunSchema.omit({ id: true, ranAt: true }).parse({
          trigger,
          blockNumber: block.toString(),
          treasuryChainAtomic: chainTreasury.toString(),
          treasuryLedgerAtomic: ledgerTreasury.toString(),
          treasuryDifferenceAtomic: treasuryDiff.toString(),
          escrowsChecked: orders.length,
          eventsChecked,
          escrows,
          materialityAtomic: materiality.toString(),
          differences,
          exceptionIds,
          status: differences.length === 0 ? "ok" : "differences",
        }),
      );
      events.push(
        await r.activityEvents.insert({
          kind: differences.length === 0 ? "reconciliation.ok" : "reconciliation.difference",
          message:
            differences.length === 0
              ? `reconciliation ${saved.id}: books match the chain at block ${block} (treasury ${chainTreasury}, ${orders.length} escrow(s), ${eventsChecked} event(s)) [reconciliation:${trigger}]`
              : `reconciliation ${saved.id}: ${differences.length} difference(s) at block ${block}, ${exceptionIds.length} new exception(s) [reconciliation:${trigger}]`,
          simulated: false,
        }),
      );
      return { saved, events };
    });
    for (const ev of events) deps.bus?.publish(ev);
    log(events.at(-1)!.message);
    return saved;
  }

  return {
    run,
    latest: () => createRepositories(deps.db).reconciliationRuns.latest(),
  };
}
