import type { Address, Hex } from "viem";
import type { BalanceReader, GetLogsRequest, LogSource, RawLog } from "./log-source.js";

/** Test-only LogSource serving a fixed (SIMULATED) log set; mutate `logs` / `head` / `balances` to model reorgs and differences. */
export interface FakeLogSource extends LogSource, BalanceReader {
  logs: RawLog[];
  head: bigint;
  calls: GetLogsRequest[];
  /** `${token}:${holder}` (lowercase) -> balance. Unknown holders read as 0. */
  balances: Map<string, bigint>;
  setBalance(token: Address, holder: Address, value: bigint): void;
}

const matchesTopics = (log: RawLog, topics: GetLogsRequest["topics"]): boolean => {
  if (!topics) return true;
  return topics.every((want, i) => {
    if (want === null) return true;
    const have = log.topics[i]?.toLowerCase();
    if (have === undefined) return false;
    const options = (Array.isArray(want) ? want : [want]).map((t: Hex) => t.toLowerCase());
    return options.includes(have);
  });
};

export function fakeLogSource(initial: RawLog[], head: bigint, blockTimestamp = 1_700_000_000n): FakeLogSource {
  const key = (token: Address, holder: Address): string => `${token.toLowerCase()}:${holder.toLowerCase()}`;
  const source: FakeLogSource = {
    logs: [...initial],
    head,
    calls: [],
    balances: new Map(),
    setBalance(token, holder, value) {
      source.balances.set(key(token, holder), value);
    },
    async getBlockNumber() {
      return source.head;
    },
    async getLogs(req: GetLogsRequest) {
      source.calls.push(req);
      const set = new Set(req.addresses.map((a: Address) => a.toLowerCase()));
      return source.logs.filter((l: RawLog) => {
        const b = BigInt(l.blockNumber);
        return b >= req.fromBlock && b <= req.toBlock && set.has(l.address.toLowerCase()) && matchesTopics(l, req.topics);
      });
    },
    async getBlockTimestamp() {
      return blockTimestamp;
    },
    async balanceOf(token, holder) {
      return source.balances.get(key(token, holder)) ?? 0n;
    },
  };
  return source;
}
