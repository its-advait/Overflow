import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type Hex, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { JournalEntrySchema, overflowEscrowAbi, overflowEscrowFactoryAbi, USDC } from "@overflow/schemas";
import type { ChainClient } from "../chain/client";
import { createBus, type FeedEvent } from "../facilitator/events";
import { createSweepReconciler, MemoryExceptions, MemoryLedger, MemoryPurchaseIndex } from "./sweeps";

const TREASURY = "0xd3A74fA991CA0B5627d30EF27dC699C134848291" as const;
const FACTORY = "0x4444444444444444444444444444444444444444" as const;
const ESCROW = "0x5555555555555555555555555555555555555555" as const;
const ESCROW2 = "0x6666666666666666666666666666666666666666" as const;
const SELLER = "0x2222222222222222222222222222222222222222" as const;
const STRANGER = "0x7777777777777777777777777777777777777777" as const;
const H = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as Hex;
const ORDER = H(0x900);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

function log(address: Address, topics: Hex[], data: Hex, blockNumber: bigint, txHash: Hex, logIndex = 0): Log {
  return { address, topics, data, blockNumber, transactionHash: txHash, logIndex, transactionIndex: 0, blockHash: H(0xb10c), removed: false } as Log;
}
const orderCreated = (escrow: Address, block: bigint, tx: Hex) =>
  log(FACTORY, encodeEventTopics({ abi: overflowEscrowFactoryAbi, eventName: "OrderCreated", args: { escrow, orderId: ORDER, buyer: TREASURY } }) as Hex[], encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [SELLER, 50000n, H(7)]), block, tx);
const paidOut = (escrow: Address, block: bigint, tx: Hex, idx = 0) =>
  log(escrow, encodeEventTopics({ abi: overflowEscrowAbi, eventName: "PaidOut" }) as Hex[], encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [SELLER, 50000n, 10000n]), block, tx, idx);
const refunded = (escrow: Address, block: bigint, tx: Hex) =>
  log(escrow, encodeEventTopics({ abi: overflowEscrowAbi, eventName: "Refunded" }) as Hex[], encodeAbiParameters([{ type: "string" }], ["timeout"]), block, tx);
const swept = (escrow: Address, amount: bigint, block: bigint, tx: Hex) =>
  log(escrow, encodeEventTopics({ abi: overflowEscrowAbi, eventName: "Swept" }) as Hex[], encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [TREASURY, amount]), block, tx);
const transfer = (from: Address, to: Address, value: bigint, block: bigint, tx: Hex, idx = 0) =>
  log(USDC.address, encodeEventTopics({ abi: [TRANSFER], eventName: "Transfer", args: { from, to } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [value]), block, tx, idx);

function fakeChain(initial: Log[]) {
  const state = { logs: [...initial], head: 200n, sent: 0, reads: 0 };
  const client: ChainClient = {
    getChainId: async () => 84532,
    getCode: async () => "0x6001",
    getBalance: async () => 0n,
    getBlockNumber: async () => state.head,
    readContract: async () => {
      state.reads++;
      return undefined;
    },
    simulateContract: async () => undefined,
    getTransactionCount: async () => 0,
    sendTransaction: async () => {
      state.sent++;
      return H(1);
    },
    waitForTransactionReceipt: async () => {
      throw new Error("unused");
    },
    getLogs: async ({ address, fromBlock, toBlock, args }) => {
      const addrs = (Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase());
      const to = (args?.["to"] as Address[] | undefined)?.map((a) => a.toLowerCase());
      return state.logs.filter((l) => {
        if (!addrs.includes(l.address.toLowerCase())) return false;
        if (l.blockNumber! < fromBlock || l.blockNumber! > toBlock) return false;
        if (to) return to.includes(`0x${(l.topics[2] ?? "").slice(26)}`.toLowerCase());
        return true;
      });
    },
  };
  return { client, state };
}

function setup(logs: Log[], opts: { confirmations?: number; purchase?: boolean } = {}) {
  const { client, state } = fakeChain(logs);
  const bus = createBus();
  const events: FeedEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const ledger = new MemoryLedger();
  const exceptions = new MemoryExceptions();
  const purchases = new MemoryPurchaseIndex();
  if (opts.purchase !== false) purchases.set(ESCROW, "purchase-1");
  const r = createSweepReconciler({ client, factory: FACTORY, usdc: USDC.address, treasury: TREASURY, bus, purchases, ledger, exceptions, fromBlock: 100n, confirmations: opts.confirmations ?? 3, reorgWindow: 20, now: () => new Date("2026-10-25T00:00:00Z") });
  return { r, state, bus, events, ledger, exceptions };
}

// a complete story: order created (101), paid out (110), late arrival from the treasury (120), swept (130)
const story = [orderCreated(ESCROW, 101n, H(0xa1)), transfer(TREASURY, ESCROW, 50000n, 105n, H(0xa5)), paidOut(ESCROW, 110n, H(0xaa)), transfer(TREASURY, ESCROW, 50000n, 120n, H(0xac)), swept(ESCROW, 50000n, 130n, H(0xad))];

describe("sweep reconciliation", () => {
  it("books a balanced late-arrival entry and a balanced sweep entry for the right purchase, and reports recovered", async () => {
    const { r, ledger, events, exceptions } = setup(story);
    expect(await r.tick()).toEqual({ booked: 2, corrected: 0, exceptions: 0 });
    const entries = await ledger.list();
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(JournalEntrySchema.safeParse(e).success).toBe(true);
    const late = entries.find((e) => e.chainEvent === "LateArrival")!;
    expect(late).toMatchObject({ id: `late:${H(0xac)}:0`, purchaseId: "purchase-1", txHash: H(0xac) });
    expect(late.lines).toEqual([
      { account: "escrow-deposit", debitAtomic: "50000", creditAtomic: "0" },
      { account: "usdc-treasury", debitAtomic: "0", creditAtomic: "50000" },
    ]);
    const sw = entries.find((e) => e.chainEvent === "Swept")!;
    expect(sw).toMatchObject({ id: `swept:${H(0xad)}:0`, purchaseId: "purchase-1", txHash: H(0xad) });
    expect(sw.lines).toEqual([
      { account: "usdc-treasury", debitAtomic: "50000", creditAtomic: "0" },
      { account: "escrow-deposit", debitAtomic: "0", creditAtomic: "50000" },
    ]);
    expect(r.late(ESCROW)).toEqual({ arrivedAtomic: 50000n, recoveredAtomic: 50000n });
    expect(await exceptions.list()).toEqual([]);
    // the funding transfer before PaidOut is not a late arrival
    expect(entries.some((e) => e.txHash === H(0xa5))).toBe(false);
    // surfaced on the event feed: a derived LateArrival and the escrow's real Swept, with purchase and status
    expect(events.map((e) => [e.kind, e.source])).toEqual([
      ["LateArrival", "derived"],
      ["Swept", "chain"],
    ]);
    expect(events[0]!.args).toMatchObject({ escrow: ESCROW, purchaseId: "purchase-1", derivedFrom: "USDC Transfer", outstandingAtomic: "50000", recovered: "false" });
    expect(events[1]!.args).toMatchObject({ escrow: ESCROW, purchaseId: "purchase-1", recoveredAtomic: "50000", outstandingAtomic: "0", recovered: "true" });
  });

  it("is idempotent across polls and never sends a transaction or reads the treasury (allowance untouched)", async () => {
    const { r, ledger, state, events } = setup(story);
    await r.tick();
    await r.tick();
    state.head += 5n;
    await r.tick();
    expect(await ledger.list()).toHaveLength(2);
    expect(events).toHaveLength(2);
    expect(state.sent).toBe(0);
    expect(state.reads).toBe(0);
  });

  it("partial: a late arrival without a sweep stays outstanding; the sweep later completes it without a duplicate", async () => {
    const { r, ledger, state, events } = setup(story.slice(0, 4));
    expect(await r.tick()).toEqual({ booked: 1, corrected: 0, exceptions: 0 });
    expect(r.late(ESCROW)).toEqual({ arrivedAtomic: 50000n, recoveredAtomic: 0n });
    expect(events.at(-1)!.args!["recovered"]).toBe("false");
    state.logs.push(swept(ESCROW, 50000n, 210n, H(0xad)));
    state.head = 213n;
    expect(await r.tick()).toEqual({ booked: 1, corrected: 0, exceptions: 0 });
    expect(await ledger.list()).toHaveLength(2);
    expect(r.late(ESCROW)).toEqual({ arrivedAtomic: 50000n, recoveredAtomic: 50000n });
    expect(events.at(-1)!).toMatchObject({ kind: "Swept", args: { recovered: "true", outstandingAtomic: "0" } });
  });

  it("partial: a sweep larger than the observed treasury arrivals books only the matched part and opens an exception", async () => {
    const logs = [...story.slice(0, 4), swept(ESCROW, 80000n, 130n, H(0xad))];
    const { r, ledger, exceptions } = setup(logs);
    expect(await r.tick()).toEqual({ booked: 2, corrected: 0, exceptions: 1 });
    const sw = (await ledger.list()).find((e) => e.chainEvent === "Swept")!;
    expect(sw.lines[0]).toMatchObject({ account: "usdc-treasury", debitAtomic: "50000" });
    const [exc] = await exceptions.list();
    expect(exc).toMatchObject({ type: "reconciliation-difference", amountAtomic: "30000", status: "open", purchaseId: "purchase-1" });
    expect(exc!.reason).toMatch(/30000 unexplained/);
  });

  it("USDC from a stranger into a closed escrow is flagged, not booked against the treasury", async () => {
    const logs = [orderCreated(ESCROW, 101n, H(0xa1)), refunded(ESCROW, 110n, H(0xaa)), transfer(STRANGER, ESCROW, 7000n, 120n, H(0xb1))];
    const { r, ledger, exceptions, events } = setup(logs);
    expect(await r.tick()).toEqual({ booked: 0, corrected: 0, exceptions: 1 });
    expect(await ledger.list()).toEqual([]);
    expect((await exceptions.list())[0]).toMatchObject({ type: "reconciliation-difference", amountAtomic: "7000" });
    expect(events[0]).toMatchObject({ kind: "LateArrival", source: "derived", args: { from: STRANGER, unexplained: "true" } });
    expect(r.late(ESCROW).arrivedAtomic).toBe(0n);
  });

  it("transfers to an escrow with no terminal event, or to an address the factory never created, are ignored", async () => {
    const logs = [orderCreated(ESCROW, 101n, H(0xa1)), transfer(TREASURY, ESCROW, 50000n, 105n, H(0xa5)), transfer(TREASURY, ESCROW2, 50000n, 106n, H(0xa6)), swept(ESCROW2, 50000n, 107n, H(0xa7))];
    const { r, ledger, exceptions } = setup(logs);
    expect(await r.tick()).toEqual({ booked: 0, corrected: 0, exceptions: 0 });
    expect(await ledger.list()).toEqual([]);
    expect(await exceptions.list()).toEqual([]);
    expect(r.escrows().map((e) => e.escrow)).toEqual([ESCROW]);
  });

  it("waits for confirmation depth before booking", async () => {
    const { r, ledger, state } = setup(story);
    state.head = 131n; // the sweep at 130 is only 1 deep
    expect(await r.tick()).toEqual({ booked: 1, corrected: 0, exceptions: 0 });
    expect((await ledger.list()).map((e) => e.chainEvent)).toEqual(["LateArrival"]);
    state.head = 133n;
    expect(await r.tick()).toEqual({ booked: 1, corrected: 0, exceptions: 0 });
    expect((await ledger.list()).map((e) => e.chainEvent).sort()).toEqual(["LateArrival", "Swept"]);
  });

  it("a booked log that disappears in a reorg gets exactly one correcting entry and the outstanding amount comes back", async () => {
    const { r, ledger, state, events } = setup(story);
    state.head = 135n;
    await r.tick();
    expect(r.late(ESCROW).recoveredAtomic).toBe(50000n);
    state.logs = state.logs.filter((l) => l.transactionHash !== H(0xad)); // the sweep tx fell out of the chain
    state.head = 140n;
    expect(await r.tick()).toEqual({ booked: 0, corrected: 1, exceptions: 0 });
    const entries = await ledger.list();
    expect(entries).toHaveLength(3);
    const fix = entries.find((e) => e.correctsEntryId)!;
    expect(fix).toMatchObject({ id: `swept:${H(0xad)}:0:reversed`, correctsEntryId: `swept:${H(0xad)}:0`, chainEvent: "Swept" });
    expect(fix.lines).toEqual([
      { account: "escrow-deposit", debitAtomic: "50000", creditAtomic: "0" },
      { account: "usdc-treasury", debitAtomic: "0", creditAtomic: "50000" },
    ]);
    expect(r.late(ESCROW)).toEqual({ arrivedAtomic: 50000n, recoveredAtomic: 0n });
    expect(events.at(-1)).toMatchObject({ kind: "Swept", args: { correction: "true", outstandingAtomic: "50000" } });
    state.head = 150n;
    expect(await r.tick()).toEqual({ booked: 0, corrected: 0, exceptions: 0 }); // never corrected twice
    // the re-mined sweep under a new hash books normally
    state.logs.push(swept(ESCROW, 50000n, 141n, H(0xae)));
    state.head = 160n;
    expect(await r.tick()).toEqual({ booked: 1, corrected: 0, exceptions: 0 });
    expect(r.late(ESCROW).recoveredAtomic).toBe(50000n);
  });

  it("without a purchase index entry the ledger still books against the escrow and order id", async () => {
    const { r, ledger, events } = setup(story, { purchase: false });
    await r.tick();
    const [late] = await ledger.list();
    expect(late!.purchaseId).toBeUndefined();
    expect(events[0]!.args).toMatchObject({ escrow: ESCROW, orderId: ORDER });
  });
});
