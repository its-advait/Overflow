import { decodeEventLog, parseAbiItem, type Address, type Hex, type Log } from "viem";
import {
  explorerUrl,
  overflowEscrowAbi,
  overflowEscrowFactoryAbi,
  type ExceptionRecord,
  type JournalEntry,
} from "@overflow/schemas";
import type { ChainClient } from "../chain/client";
import type { Bus } from "../facilitator/events";

/**
 * Sweep reconciliation (docs/PROGRESS.md follow-up from the sweep patch, Workstream B).
 *
 * Learns escrows from the factory's OrderCreated logs, then watches two things per escrow:
 *   - USDC `Transfer` logs INTO the escrow after its terminal event (PaidOut / Refunded). The service derives a
 *     `LateArrival` from each one; no contract emits such an event. From the treasury it is booked
 *     debit escrow-deposit / credit usdc-treasury. From anyone else it opens a reconciliation exception.
 *   - the escrow's own `Swept` event: booked debit usdc-treasury / credit escrow-deposit for the part that matches
 *     observed treasury late arrivals; any excess opens a reconciliation exception.
 * Entries are keyed by txHash:logIndex (idempotent across polls). Logs are booked only `confirmations` blocks deep;
 * the last `reorgWindow` blocks are re-scanned on every tick and a booked log that vanished gets one correcting
 * entry (`correctsEntryId`). Nothing here sends a transaction or touches the treasury: the agent's spent
 * allowance stays exactly as the contracts left it.
 */

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export type EscrowInfo = {
  escrow: Address;
  orderId: Hex;
  buyer: Address;
  seller: Address;
  amountAtomic: string;
  terminal?: { kind: "PaidOut" | "Refunded"; blockNumber: bigint; logIndex: number; txHash: Hex };
};

export interface PurchaseIndex {
  byEscrow(escrow: Address): Promise<{ id: string } | undefined>;
}
export class MemoryPurchaseIndex implements PurchaseIndex {
  private readonly m = new Map<string, { id: string }>();
  set(escrow: Address, id: string) {
    this.m.set(escrow.toLowerCase(), { id });
  }
  async byEscrow(escrow: Address) {
    return this.m.get(escrow.toLowerCase());
  }
}

export interface Ledger {
  /** Insert only; false when the id exists (idempotent booking). */
  post(entry: JournalEntry): Promise<boolean>;
  list(): Promise<JournalEntry[]>;
}
export class MemoryLedger implements Ledger {
  private readonly m = new Map<string, JournalEntry>();
  async post(e: JournalEntry) {
    if (this.m.has(e.id)) return false;
    this.m.set(e.id, e);
    return true;
  }
  async list() {
    return [...this.m.values()];
  }
}

export interface ExceptionSink {
  open(rec: ExceptionRecord): Promise<boolean>;
  list(): Promise<ExceptionRecord[]>;
}
export class MemoryExceptions implements ExceptionSink {
  private readonly m = new Map<string, ExceptionRecord>();
  async open(r: ExceptionRecord) {
    if (this.m.has(r.id)) return false;
    this.m.set(r.id, r);
    return true;
  }
  async list() {
    return [...this.m.values()];
  }
}

type Booked = {
  entryId: string;
  kind: "LateArrival" | "Swept";
  escrow: Address;
  amount: bigint; // the amount the entry booked (for Swept: the recovered part)
  blockNumber: bigint;
  reversed?: boolean;
};

export type LateState = { arrivedAtomic: bigint; recoveredAtomic: bigint };

export type SweepReconciler = {
  tick(): Promise<{ booked: number; corrected: number; exceptions: number }>;
  start(): void;
  stop(): void;
  escrows(): EscrowInfo[];
  late(escrow: Address): LateState;
};

export function createSweepReconciler(opts: {
  client: ChainClient;
  factory: Address;
  usdc: Address;
  treasury: Address;
  bus: Bus;
  purchases: PurchaseIndex;
  ledger: Ledger;
  exceptions: ExceptionSink;
  fromBlock: bigint;
  confirmations?: number;
  reorgWindow?: number;
  intervalMs?: number;
  now?: () => Date;
  log?: (l: string) => void;
}): SweepReconciler {
  const confirmations = BigInt(opts.confirmations ?? 3);
  const reorgWindow = BigInt(opts.reorgWindow ?? 12);
  const now = opts.now ?? (() => new Date());
  const escrows = new Map<string, EscrowInfo>(); // lower-cased address -> info
  const booked = new Map<string, Booked>(); // txHash:logIndex -> entry
  const late = new Map<string, LateState>();
  let scannedTo = opts.fromBlock - 1n;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const key = (l: Log) => `${l.transactionHash}:${l.logIndex}`;
  const lower = (a: string) => a.toLowerCase();
  const lateOf = (escrow: Address): LateState => {
    const k = lower(escrow);
    let s = late.get(k);
    if (!s) {
      s = { arrivedAtomic: 0n, recoveredAtomic: 0n };
      late.set(k, s);
    }
    return s;
  };
  const outstanding = (escrow: Address) => {
    const s = lateOf(escrow);
    return s.arrivedAtomic - s.recoveredAtomic;
  };
  const after = (l: Log, t: NonNullable<EscrowInfo["terminal"]>) =>
    l.blockNumber! > t.blockNumber || (l.blockNumber! === t.blockNumber && l.logIndex! > t.logIndex);
  const byPosition = (a: Log, b: Log) =>
    a.blockNumber! === b.blockNumber! ? a.logIndex! - b.logIndex! : a.blockNumber! < b.blockNumber! ? -1 : 1;

  function entry(id: string, memo: string, lines: JournalEntry["lines"], meta: Partial<JournalEntry>): JournalEntry {
    return { id, postedAt: now().toISOString(), memo, lines, ...meta };
  }

  async function bookLateArrival(l: Log, info: EscrowInfo, from: Address, value: bigint): Promise<"booked" | "exception" | "seen"> {
    const k = key(l);
    if (booked.has(k)) return "seen";
    const purchase = await opts.purchases.byEscrow(info.escrow);
    const txHash = l.transactionHash!;
    const amount = value.toString();
    const common = { escrow: info.escrow, orderId: info.orderId, ...(purchase ? { purchaseId: purchase.id } : {}), amount, from, derivedFrom: "USDC Transfer" };
    if (lower(from) !== lower(opts.treasury)) {
      // USDC from someone else landed in our closed escrow: not our money, not our ledger. Flag it.
      const id = `exc:${k}`;
      const opened = await opts.exceptions.open({
        id,
        type: "RECONCILIATION_DIFF",
        reason: `USDC ${amount} reached closed escrow ${info.escrow} from ${from}, not from the treasury; not booked`,
        amountAtomic: amount,
        status: "open",
        openedAt: now().toISOString(),
        ...(purchase ? { purchaseId: purchase.id } : {}),
      });
      booked.set(k, { entryId: id, kind: "LateArrival", escrow: info.escrow, amount: 0n, blockNumber: l.blockNumber! });
      opts.bus.publish({ kind: "LateArrival", source: "derived", txHash, explorerUrl: explorerUrl("tx", txHash), blockNumber: l.blockNumber!.toString(), args: { ...common, unexplained: "true", outstandingAtomic: outstanding(info.escrow).toString() } });
      return opened ? "exception" : "seen";
    }
    const id = `late:${k}`;
    const posted = await opts.ledger.post(
      entry(
        id,
        `late arrival: ${amount} USDC from the treasury into closed escrow ${info.escrow} (order ${info.orderId}); derived from USDC Transfer, awaiting sweep()`,
        [
          { account: "escrow-deposit", debitAtomic: amount, creditAtomic: "0" },
          { account: "usdc-treasury", debitAtomic: "0", creditAtomic: amount },
        ],
        { txHash, chainEvent: "LateArrival", ...(purchase ? { purchaseId: purchase.id } : {}) },
      ),
    );
    if (!posted) return "seen";
    booked.set(k, { entryId: id, kind: "LateArrival", escrow: info.escrow, amount: value, blockNumber: l.blockNumber! });
    lateOf(info.escrow).arrivedAtomic += value;
    opts.bus.publish({ kind: "LateArrival", source: "derived", txHash, explorerUrl: explorerUrl("tx", txHash), blockNumber: l.blockNumber!.toString(), args: { ...common, outstandingAtomic: outstanding(info.escrow).toString(), recovered: "false" } });
    return "booked";
  }

  async function bookSwept(l: Log, info: EscrowInfo, buyer: Address, value: bigint): Promise<{ booked: boolean; exception: boolean }> {
    const k = key(l);
    if (booked.has(k)) return { booked: false, exception: false };
    const purchase = await opts.purchases.byEscrow(info.escrow);
    const txHash = l.transactionHash!;
    const out = outstanding(info.escrow);
    const recovered = value < out ? value : out;
    const excess = value - recovered;
    let exception = false;
    let posted = false;
    const id = `swept:${k}`;
    if (recovered > 0n) {
      posted = await opts.ledger.post(
        entry(
          id,
          `sweep: ${recovered.toString()} USDC recovered from closed escrow ${info.escrow} to the treasury ${buyer}`,
          [
            { account: "usdc-treasury", debitAtomic: recovered.toString(), creditAtomic: "0" },
            { account: "escrow-deposit", debitAtomic: "0", creditAtomic: recovered.toString() },
          ],
          { txHash, chainEvent: "Swept", ...(purchase ? { purchaseId: purchase.id } : {}) },
        ),
      );
      if (posted) lateOf(info.escrow).recoveredAtomic += recovered;
    }
    if (excess > 0n) {
      exception = await opts.exceptions.open({
        id: `exc:${k}`,
        type: "RECONCILIATION_DIFF",
        reason: `sweep() of escrow ${info.escrow} moved ${value.toString()} but only ${out.toString()} of treasury late arrivals were observed; ${excess.toString()} unexplained`,
        amountAtomic: excess.toString(),
        status: "open",
        openedAt: now().toISOString(),
        ...(purchase ? { purchaseId: purchase.id } : {}),
      });
    }
    booked.set(k, { entryId: id, kind: "Swept", escrow: info.escrow, amount: recovered, blockNumber: l.blockNumber! });
    const remaining = outstanding(info.escrow);
    opts.bus.publish({
      kind: "Swept",
      source: "chain",
      txHash,
      explorerUrl: explorerUrl("tx", txHash),
      blockNumber: l.blockNumber!.toString(),
      args: {
        escrow: info.escrow,
        orderId: info.orderId,
        ...(purchase ? { purchaseId: purchase.id } : {}),
        buyer,
        amount: value.toString(),
        recoveredAtomic: recovered.toString(),
        unexplainedAtomic: excess.toString(),
        outstandingAtomic: remaining.toString(),
        recovered: remaining === 0n ? "true" : "false",
      },
    });
    return { booked: posted, exception };
  }

  /** A booked log is no longer in the chain (reorg): one reversing entry, once. */
  async function correct(k: string, b: Booked): Promise<boolean> {
    if (b.reversed) return false;
    b.reversed = true;
    if (b.amount === 0n) return false; // an exception-only record has nothing to reverse
    const amount = b.amount.toString();
    const lines: JournalEntry["lines"] =
      b.kind === "LateArrival"
        ? [
            { account: "usdc-treasury", debitAtomic: amount, creditAtomic: "0" },
            { account: "escrow-deposit", debitAtomic: "0", creditAtomic: amount },
          ]
        : [
            { account: "escrow-deposit", debitAtomic: amount, creditAtomic: "0" },
            { account: "usdc-treasury", debitAtomic: "0", creditAtomic: amount },
          ];
    const posted = await opts.ledger.post(
      entry(`${b.entryId}:reversed`, `reorg: the ${b.kind} log ${k} is no longer in the chain; reverses ${b.entryId}`, lines, { correctsEntryId: b.entryId, chainEvent: b.kind }),
    );
    if (posted) {
      const s = lateOf(b.escrow);
      if (b.kind === "LateArrival") s.arrivedAtomic -= b.amount;
      else s.recoveredAtomic -= b.amount;
      opts.bus.publish({ kind: b.kind, source: b.kind === "Swept" ? "chain" : "derived", args: { escrow: b.escrow, correction: "true", reversesEntry: b.entryId, amount, outstandingAtomic: outstanding(b.escrow).toString() } });
    }
    return posted;
  }

  async function tick() {
    const result = { booked: 0, corrected: 0, exceptions: 0 };
    if (running) return result;
    running = true;
    try {
      const head = await opts.client.getBlockNumber();
      const confirmed = head - confirmations;
      if (confirmed < opts.fromBlock) return result;
      const from = scannedTo + 1n - reorgWindow < opts.fromBlock ? opts.fromBlock : scannedTo + 1n - reorgWindow;
      const to = confirmed;
      if (to < from) return result;

      // 1. escrows from the factory
      for (const l of await opts.client.getLogs({ address: opts.factory, fromBlock: from, toBlock: to })) {
        try {
          const d = decodeEventLog({ abi: overflowEscrowFactoryAbi, data: l.data, topics: l.topics, strict: false });
          if (d.eventName !== "OrderCreated") continue;
          const a = d.args as { escrow: Address; orderId: Hex; buyer: Address; seller: Address; amount: bigint };
          if (!escrows.has(lower(a.escrow))) {
            escrows.set(lower(a.escrow), { escrow: a.escrow, orderId: a.orderId, buyer: a.buyer, seller: a.seller, amountAtomic: a.amount.toString() });
          }
        } catch {
          /* not an event we read */
        }
      }
      const addresses = [...escrows.values()].map((e) => e.escrow);
      const seen = new Set<string>();
      if (addresses.length > 0) {
        // 2. escrow logs: terminal markers and sweeps; 3. USDC transfers into escrows
        const escrowLogs = await opts.client.getLogs({ address: addresses, fromBlock: from, toBlock: to });
        const transfers = await opts.client.getLogs({ address: opts.usdc, fromBlock: from, toBlock: to, event: TRANSFER, args: { to: addresses } });
        const ordered = [...escrowLogs, ...transfers].sort(byPosition);
        for (const l of ordered) {
          if (l.blockNumber === null || l.logIndex === null || !l.transactionHash) continue;
          const info = escrows.get(lower(l.address));
          if (info) {
            let d: { eventName: string; args: unknown };
            try {
              d = decodeEventLog({ abi: overflowEscrowAbi, data: l.data, topics: l.topics, strict: false }) as typeof d;
            } catch {
              continue;
            }
            if (d.eventName === "PaidOut" || d.eventName === "Refunded") {
              const t = { kind: d.eventName as "PaidOut" | "Refunded", blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash };
              if (!info.terminal || after({ blockNumber: info.terminal.blockNumber, logIndex: info.terminal.logIndex } as Log, t)) info.terminal = t;
            } else if (d.eventName === "Swept") {
              seen.add(key(l));
              const a = d.args as { buyer: Address; amount: bigint };
              const r = await bookSwept(l, info, a.buyer, a.amount);
              if (r.booked) result.booked++;
              if (r.exception) result.exceptions++;
            }
            continue;
          }
          if (lower(l.address) === lower(opts.usdc)) {
            let d: { args: { from: Address; to: Address; value: bigint } };
            try {
              d = decodeEventLog({ abi: [TRANSFER], data: l.data, topics: l.topics }) as typeof d;
            } catch {
              continue;
            }
            const target = escrows.get(lower(d.args.to));
            if (!target?.terminal || !after(l, target.terminal)) continue; // funding or payout traffic, not a late arrival
            seen.add(key(l));
            const r = await bookLateArrival(l, target, d.args.from, d.args.value);
            if (r === "booked") result.booked++;
            if (r === "exception") result.exceptions++;
          }
        }
      }
      // 4. reorg check: anything booked inside the re-scanned window must still be there
      for (const [k, b] of booked) {
        if (b.blockNumber < from || b.blockNumber > to || seen.has(k)) continue;
        if (await correct(k, b)) result.corrected++;
      }
      scannedTo = to;
      return result;
    } catch (e) {
      opts.log?.(`[reconcile] tick failed: ${e instanceof Error ? e.message : String(e)}`);
      return result;
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (!timer) timer = setInterval(() => void tick(), opts.intervalMs ?? 8000);
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    escrows: () => [...escrows.values()],
    late: (escrow) => ({ ...lateOf(escrow) }),
  };
}
