import type { Address } from "viem";
import type { GetLogsRequest, LogSource, RawLog } from "./client.js";

/** Test-only LogSource serving a fixed (SIMULATED) log set; mutate `logs` / `head` to model reorgs. */
export interface FakeLogSource extends LogSource {
  logs: RawLog[];
  head: bigint;
  calls: GetLogsRequest[];
}

export function fakeLogSource(initial: RawLog[], head: bigint, blockTimestamp = 1_700_000_000n): FakeLogSource {
  const source: FakeLogSource = {
    logs: [...initial],
    head,
    calls: [],
    async getBlockNumber() {
      return source.head;
    },
    async getLogs(req: GetLogsRequest) {
      source.calls.push(req);
      const set = new Set(req.addresses.map((a: Address) => a.toLowerCase()));
      return source.logs.filter((l: RawLog) => {
        const b = BigInt(l.blockNumber);
        return b >= req.fromBlock && b <= req.toBlock && set.has(l.address.toLowerCase());
      });
    },
    async getBlockTimestamp() {
      return blockTimestamp;
    },
  };
  return source;
}
