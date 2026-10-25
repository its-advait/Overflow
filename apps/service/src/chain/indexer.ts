import { createRepositories, InvalidEscrowTransitionError, NotFoundError, type Db } from "@overflow/database";
import { InvalidTransitionError, type ActivityEvent, type Address, type FinancialEntry } from "@overflow/schemas";
import { padHex } from "viem";
import { postForLog } from "../ledger/posting.js";
import { createPurchaseService, TransitionEvidenceError } from "../orchestration/purchase-service.js";
import { TRANSFER_TOPIC } from "./abi.js";
import type { ActivityBus, IndexerStatus } from "./bus.js";
import type { LogSource, RawLog } from "./client.js";
import type { IndexerConfig } from "./config.js";
import { decodeLog, type DecodedLog } from "./decode.js";
import { handlerFor, type HandlerResult } from "./handlers.js";

// ---------------------------------------------------------------------------
// Event indexer. Polls eth_getLogs for the treasury, the factory and every
// escrow the factory created, and turns each log into:
//   1. a chain_transactions row (idempotent on tx_hash + log_index),
//   2. the handler's effects (purchases / escrow orders through
//      PurchaseService.transition, reservations, seller history),
//   3. the ledger's journal rows for that event (ledger/posting.ts), posted
//      after the handler so the books follow the chain even when the purchase
//      state machine refuses the move,
//   4. activity events, published on the bus after commit.
// Besides the Overflow contracts it reads USDC's Transfer logs into and out of
// the treasury: funding and direct x402 purchases have no treasury event.
// A cursor (indexer_cursors) records the highest block fully scanned. Every
// poll re-reads the last `reorgDepth` blocks; a stored log that the chain no
// longer returns in that window is marked confirmed = false.
// ---------------------------------------------------------------------------

export const DEFAULT_CURSOR_NAME = "indexer:base-sepolia";

export interface IndexerDeps {
  db: Db;
  source: LogSource;
  config: IndexerConfig;
  bus?: ActivityBus | undefined;
  cursorName?: string | undefined;
  log?: ((message: string) => void) | undefined;
  warn?: ((message: string) => void) | undefined;
  /** Runs after each completed poll (e.g. reconciliation). Errors are logged, never thrown. */
  afterTick?: ((result: TickResult) => Promise<void>) | undefined;
}

export interface TickResult {
  fromBlock: bigint;
  toBlock: bigint;
  logsSeen: number;
  logsInserted: number;
  unconfirmed: number;
  events: ActivityEvent[];
  entries: FinancialEntry[];
}

export interface Indexer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One poll. Exported for tests; `start()` calls it on a timer. */
  tick(): Promise<TickResult>;
  status(): IndexerStatus;
  trackedEscrows(): readonly Address[];
}

const logKey = (l: { transactionHash: string; logIndex: number }): string => `${l.transactionHash.toLowerCase()}:${l.logIndex}`;
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function isRefusedByStateMachine(e: unknown): boolean {
  return (
    e instanceof InvalidTransitionError ||
    e instanceof TransitionEvidenceError ||
    e instanceof InvalidEscrowTransitionError ||
    e instanceof NotFoundError
  );
}

export function createIndexer(deps: IndexerDeps): Indexer {
  const { db, source, config } = deps;
  const cursorName = deps.cursorName ?? DEFAULT_CURSOR_NAME;
  const log = deps.log ?? ((m: string) => console.log(`[chain] ${m}`));
  const warn = deps.warn ?? ((m: string) => console.warn(`[chain] ${m}`));
  const deployBlock = BigInt(config.deployBlock);
  const reorgDepth = BigInt(config.reorgDepth);
  const chunk = BigInt(config.chunkBlocks);
  const treasuryTopic = padHex(config.treasury, { size: 32 });
  const isUsdc = (address: string): boolean => address.toLowerCase() === config.usdc.toLowerCase();

  const escrows = new Map<string, Address>(); // lowercase -> as emitted
  let state: IndexerStatus["state"] = "idle";
  let cursor: bigint | undefined;
  let head: bigint | undefined;
  let lastPollAt: string | undefined;
  let lastError: string | undefined;
  let logsIndexed = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  let inFlight: Promise<unknown> | undefined;
  let loaded = false;

  const status = (): IndexerStatus => ({
    state,
    chainId: config.chainId,
    treasury: config.treasury,
    escrowFactory: config.escrowFactory,
    ...(cursor !== undefined ? { cursor: cursor.toString() } : {}),
    ...(head !== undefined ? { head: head.toString() } : {}),
    ...(cursor !== undefined && head !== undefined ? { lagBlocks: maxBig(head - cursor, 0n).toString() } : {}),
    trackedEscrows: escrows.size,
    ...(lastPollAt ? { lastPollAt } : {}),
    ...(lastError ? { lastError } : {}),
    logsIndexed,
  });
  const publishStatus = (): void => deps.bus?.publishStatus(status());

  const addresses = (): Address[] => [config.treasury, config.escrowFactory, ...escrows.values()];
  const track = (escrow: Address): boolean => {
    const k = escrow.toLowerCase();
    if (escrows.has(k)) return false;
    escrows.set(k, escrow);
    return true;
  };

  /** Loads the cursor and the escrows discovered in earlier runs (from stored OrderCreated logs). */
  async function load(): Promise<void> {
    if (loaded) return;
    const repos = createRepositories(db);
    const saved = await repos.indexerCursors.get(cursorName);
    cursor = saved ? BigInt(saved.lastBlock) : undefined;
    for (const row of await repos.chainTransactions.listByEvent("OrderCreated")) {
      const escrow = row.args["escrow"];
      if (typeof escrow === "string") track(escrow as Address);
    }
    loaded = true;
    log(`cursor ${cursor?.toString() ?? "none (starting at deployBlock " + deployBlock + ")"}, ${escrows.size} escrow(s) tracked`);
  }

  interface Processed {
    inserted: boolean;
    events: ActivityEvent[];
    entries: FinancialEntry[];
    newEscrow?: Address | undefined;
  }

  /** Record one log, run its handler and post its journal rows in one transaction. Returns inserted=false when the log was already stored. */
  async function processLog(decoded: DecodedLog): Promise<Processed> {
    const raw = decoded.log;
    return db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const recorded = await repos.chainTransactions.record({
        txHash: raw.transactionHash,
        logIndex: raw.logIndex,
        blockNumber: raw.blockNumber,
        contractAddress: raw.address,
        eventName: decoded.eventName,
        args: decoded.args,
        confirmed: true,
      });
      if (!recorded.inserted) {
        if (!recorded.row.confirmed) await repos.chainTransactions.setConfirmed(recorded.row.id, true); // back on the canonical chain
        return { inserted: false, events: [], entries: [] };
      }
      let handled: HandlerResult = { events: [] };
      const handler = handlerFor(decoded.eventName);
      if (handler) {
        try {
          // Savepoint: a refused state-machine move rolls back only the handler; the chain row stays.
          handled = await tx.transaction((inner) =>
            handler({
              repos: createRepositories(inner),
              purchases: createPurchaseService(inner),
              row: recorded.row,
              decoded,
              txHash: raw.transactionHash,
              treasury: config.treasury,
              blockTimestamp: async () =>
                raw.blockTimestamp !== undefined ? BigInt(raw.blockTimestamp) : source.getBlockTimestamp(BigInt(raw.blockNumber)),
              warn,
            }),
          );
        } catch (e) {
          if (!isRefusedByStateMachine(e)) throw e;
          warn(`${decoded.eventName} ${logKey(raw)} recorded but refused by the state machine: ${(e as Error).message}`);
          handled = { events: [], newEscrow: decoded.eventName === "OrderCreated" ? (decoded.args["escrow"] as Address) : undefined };
        }
      }
      // The books follow the chain: posted after the handler, inside the same commit, whether or not the move was refused.
      const row = (await repos.chainTransactions.getById(recorded.row.id)) ?? recorded.row;
      const entries = await postForLog({ repos, row, decoded, treasury: config.treasury, warn });
      return { inserted: true, events: handled.events, entries, newEscrow: handled.newEscrow };
    });
  }

  function sortLogs(logs: RawLog[]): RawLog[] {
    return [...logs].sort((a, b) => {
      const d = BigInt(a.blockNumber) - BigInt(b.blockNumber);
      return d === 0n ? a.logIndex - b.logIndex : d < 0n ? -1 : 1;
    });
  }

  /** Fetch a range for the current address set (plus USDC transfers touching the treasury), then again for any escrow created inside it. */
  async function fetchRange(fromBlock: bigint, toBlock: bigint, seen: Set<string>): Promise<{ logs: RawLog[]; seenKeys: string[] }> {
    let pending = addresses();
    const out: RawLog[] = [];
    const seenKeys: string[] = [];
    const usdcQueries = [
      { addresses: [config.usdc], fromBlock, toBlock, topics: [TRANSFER_TOPIC, treasuryTopic] }, // from the treasury
      { addresses: [config.usdc], fromBlock, toBlock, topics: [TRANSFER_TOPIC, null, treasuryTopic] }, // to the treasury
    ];
    let first = true;
    while (pending.length > 0) {
      const logs = await source.getLogs({ addresses: pending, fromBlock, toBlock });
      if (first) {
        first = false;
        for (const q of usdcQueries) logs.push(...(await source.getLogs(q)).filter((l) => isUsdc(l.address)));
      }
      const discovered: Address[] = [];
      for (const l of logs) {
        if (l.removed) continue;
        const k = logKey(l);
        if (seen.has(k)) continue;
        seen.add(k);
        seenKeys.push(k);
        out.push(l);
        const decoded = decodeLog(l);
        if (decoded?.eventName === "OrderCreated") {
          const escrow = decoded.args["escrow"];
          if (typeof escrow === "string" && track(escrow as Address)) discovered.push(escrow as Address);
        }
      }
      pending = discovered;
    }
    return { logs: sortLogs(out), seenKeys };
  }

  async function tick(): Promise<TickResult> {
    await load();
    const latest = await source.getBlockNumber();
    head = latest;
    lastPollAt = new Date().toISOString();
    const previousCursor = cursor;
    const fromBlock = previousCursor === undefined ? deployBlock : maxBig(deployBlock, previousCursor + 1n - reorgDepth);
    const result: TickResult = { fromBlock, toBlock: latest, logsSeen: 0, logsInserted: 0, unconfirmed: 0, events: [], entries: [] };
    if (fromBlock > latest) {
      publishStatus();
      await afterTick(result);
      return result;
    }

    const seen = new Set<string>();
    const seenInWindow = new Set<string>();
    const windowEnd = previousCursor === undefined ? undefined : minBig(previousCursor, latest);
    const repos = createRepositories(db);

    for (let start = fromBlock; start <= latest; start += chunk) {
      const end = minBig(start + chunk - 1n, latest);
      const { logs, seenKeys } = await fetchRange(start, end, seen);
      if (windowEnd !== undefined) for (const k of seenKeys) seenInWindow.add(k);
      for (const raw of logs) {
        const decoded = decodeLog(raw);
        if (!decoded) continue;
        if (decoded.kind === "usdc" && !isUsdc(raw.address)) continue; // a Transfer from some other contract is not money
        result.logsSeen++;
        const r = await processLog(decoded);
        if (r.inserted) {
          result.logsInserted++;
          logsIndexed++;
        }
        result.entries.push(...r.entries);
        for (const ev of r.events) {
          result.events.push(ev);
          deps.bus?.publish(ev);
        }
      }
      // Reorg window: stored logs the chain no longer returns lose their confirmation.
      if (windowEnd !== undefined && start <= windowEnd) {
        const stored = await repos.chainTransactions.listInBlockRange(start, minBig(end, windowEnd));
        for (const row of stored) {
          const key = logKey({ transactionHash: row.txHash, logIndex: row.logIndex });
          if (seenInWindow.has(key) || !row.confirmed) continue;
          await repos.chainTransactions.setConfirmed(row.id, false);
          const ev = await repos.activityEvents.insert({
            kind: "indexer.unconfirmed",
            message: `${row.eventName} in block ${row.blockNumber} is no longer on the canonical chain (reorg); record kept, confirmation withdrawn`,
            txHash: row.txHash as `0x${string}`,
            ...(row.purchaseId ? { purchaseId: row.purchaseId } : {}),
            simulated: false,
          });
          result.unconfirmed++;
          result.events.push(ev);
          deps.bus?.publish(ev);
        }
      }
      cursor = end;
      await repos.indexerCursors.set(cursorName, end);
    }
    lastError = undefined;
    publishStatus();
    await afterTick(result);
    return result;
  }

  async function afterTick(result: TickResult): Promise<void> {
    if (!deps.afterTick) return;
    try {
      await deps.afterTick(result);
    } catch (e) {
      warn(`afterTick hook failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function guardedTick(): Promise<TickResult> {
    if (inFlight) await inFlight.catch(() => undefined);
    const run = tick().catch((e: unknown) => {
      lastError = e instanceof Error ? e.message : String(e);
      warn(`poll failed: ${lastError}`);
      publishStatus();
      throw e;
    });
    inFlight = run;
    try {
      return await run;
    } finally {
      inFlight = undefined;
    }
  }

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      state = "starting";
      await load();
      state = "indexing";
      publishStatus();
      const loop = async (): Promise<void> => {
        if (stopped) return;
        await guardedTick().catch(() => undefined);
        if (!stopped) timer = setTimeout(() => void loop(), config.pollMs);
      };
      void loop();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (inFlight) await inFlight.catch(() => undefined);
      state = "stopped";
      publishStatus();
    },
    tick: guardedTick,
    status,
    trackedEscrows: () => [...escrows.values()],
  };
}
