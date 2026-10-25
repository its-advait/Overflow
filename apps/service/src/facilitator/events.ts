import { decodeEventLog, type Address, type Hex, type Log } from "viem";
import { explorerUrl, overflowTreasuryAbi } from "@overflow/schemas";
import type { ChainClient } from "../chain/client";
import type { Decoded } from "./decode";

/**
 * Event feed for GET /events. Chain events come from treasury and escrow logs (never from local flags);
 * `Reverted` and `BypassRejected`/`BypassSucceeded` are the only facilitator-sourced kinds, and `LateArrival` is
 * the only derived kind (the reconciler infers it from a USDC Transfer into a closed escrow). `source` says which.
 */
export type ChainEventKind =
  | "Paid"
  | "Reserved"
  | "ReservationReleased"
  | "NodeCreated"
  | "NodePaused"
  | "NodeUnpaused"
  | "CapRaised"
  | "AllowSet"
  | "EscrowFactorySet"
  | "ReservationWindowSet"
  | "Swept";
export type LocalEventKind = "Reverted" | "BypassRejected" | "BypassSucceeded";
export type DerivedEventKind = "LateArrival";

export type FeedEvent = {
  seq: number;
  at: string;
  kind: ChainEventKind | LocalEventKind | DerivedEventKind;
  source: "chain" | "facilitator" | "derived";
  txHash?: Hex;
  explorerUrl?: string;
  blockNumber?: string;
  args?: Record<string, string>;
  route?: string;
  digest?: Hex;
  decoded?: Decoded;
  simulated?: true;
};

export type Bus = {
  publish(e: Omit<FeedEvent, "seq" | "at">): FeedEvent;
  subscribe(fn: (e: FeedEvent) => void): () => void;
  replay(): FeedEvent[];
};

export function createBus(opts: { capacity?: number; now?: () => Date } = {}): Bus {
  const cap = opts.capacity ?? 200;
  const now = opts.now ?? (() => new Date());
  const ring: FeedEvent[] = [];
  const subs = new Set<(e: FeedEvent) => void>();
  let seq = 0;
  return {
    publish(e) {
      const ev: FeedEvent = { ...e, seq: ++seq, at: now().toISOString() };
      ring.push(ev);
      if (ring.length > cap) ring.shift();
      for (const s of subs) s(ev);
      return ev;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    replay: () => [...ring],
  };
}

function str(v: unknown): string {
  return typeof v === "bigint" ? v.toString() : String(v);
}

/** Decode one treasury log into a feed event, or undefined for logs we do not stream. */
export function logToEvent(log: Log): Omit<FeedEvent, "seq" | "at"> | undefined {
  let decoded: { eventName: string; args: unknown };
  try {
    decoded = decodeEventLog({ abi: overflowTreasuryAbi, data: log.data, topics: log.topics, strict: false }) as {
      eventName: string;
      args: unknown;
    };
  } catch {
    return undefined;
  }
  const kind = decoded.eventName as ChainEventKind;
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries((decoded.args ?? {}) as Record<string, unknown>)) args[k] = str(v);
  const txHash = log.transactionHash ?? undefined;
  return {
    kind,
    source: "chain",
    ...(txHash ? { txHash, explorerUrl: explorerUrl("tx", txHash) } : {}),
    ...(log.blockNumber !== null && log.blockNumber !== undefined ? { blockNumber: log.blockNumber.toString() } : {}),
    args,
  };
}

/** Polls treasury logs from `fromBlock`, dedups by txHash+logIndex, publishes to the bus. */
export function createLogPoller(opts: {
  client: ChainClient;
  treasury: Address;
  bus: Bus;
  fromBlock: bigint;
  intervalMs: number;
  log?: (l: string) => void;
}) {
  const seen = new Set<string>();
  let next = opts.fromBlock;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    try {
      const head = await opts.client.getBlockNumber();
      if (head < next) return 0;
      const logs = await opts.client.getLogs({ address: opts.treasury, fromBlock: next, toBlock: head });
      let n = 0;
      for (const l of logs) {
        const id = `${l.transactionHash}:${l.logIndex}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const ev = logToEvent(l);
        if (ev) {
          opts.bus.publish(ev);
          n++;
        }
      }
      next = head + 1n;
      return n;
    } catch (e) {
      opts.log?.(`[events] poll failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (!timer) timer = setInterval(() => void tick(), opts.intervalMs);
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
