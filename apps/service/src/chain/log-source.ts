import { CHAIN_ID } from "@overflow/schemas";
import { createPublicClient, erc20Abi, http, numberToHex, type Address, type Hex, type Log } from "viem";
import { baseSepolia } from "viem/chains";

/** The subset of a viem log the indexer needs; JSON-friendly (bigints as decimal strings). */
export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: string;
  /** Unix seconds of the containing block, when the source knows it. */
  blockTimestamp?: string | undefined;
  transactionHash: Hex;
  logIndex: number;
  removed?: boolean | undefined;
}

/** eth_getLogs topic filter: positional, `null` matches anything, an array matches any of its values. */
export type TopicFilter = (Hex | Hex[] | null)[];

export interface GetLogsRequest {
  addresses: readonly Address[];
  fromBlock: bigint;
  toBlock: bigint;
  topics?: TopicFilter | undefined;
}

/**
 * Structural subset of viem's PublicClient (pattern: payment-client's
 * TokenDomainReader). Tests implement it with a plain object serving a fixture.
 */
export interface LogSource {
  getBlockNumber(): Promise<bigint>;
  getLogs(req: GetLogsRequest): Promise<RawLog[]>;
  /** Unix seconds of a block; used to judge reveal deadlines. */
  getBlockTimestamp(blockNumber: bigint): Promise<bigint>;
}

/** ERC-20 balance reads for reconciliation; `blockNumber` pins the read to the books' height. */
export interface BalanceReader {
  balanceOf(token: Address, holder: Address, blockNumber?: bigint): Promise<bigint>;
}

type RpcLog = Log<bigint, number, false>;

function toRawLog(l: RpcLog): RawLog {
  return {
    address: l.address,
    topics: [...l.topics],
    data: l.data,
    blockNumber: l.blockNumber.toString(),
    transactionHash: l.transactionHash,
    logIndex: l.logIndex,
    removed: l.removed,
  };
}

/** viem-backed LogSource + BalanceReader for Base Sepolia. `assertChain()` fails loudly on the wrong network. */
export function createLogSource(rpcUrl: string): LogSource & BalanceReader & { assertChain(): Promise<void> } {
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const timestamps = new Map<string, bigint>();
  return {
    async assertChain() {
      const id = await client.getChainId();
      if (id !== CHAIN_ID) throw new Error(`[chain] RPC is chain ${id}, expected Base Sepolia ${CHAIN_ID}`);
    },
    getBlockNumber: () => client.getBlockNumber(),
    async getLogs({ addresses, fromBlock, toBlock, topics }) {
      if (addresses.length === 0) return [];
      if (!topics) {
        const logs = await client.getLogs({ address: [...addresses], fromBlock, toBlock });
        return logs
          .filter((l) => l.blockNumber !== null && l.transactionHash !== null && l.logIndex !== null)
          .map((l) => toRawLog(l as RpcLog));
      }
      // Raw eth_getLogs for a positional topic filter (viem's typed getLogs wants an event + args).
      const raw = await client.request({
        method: "eth_getLogs",
        params: [
          {
            address: [...addresses],
            topics,
            fromBlock: numberToHex(fromBlock),
            toBlock: numberToHex(toBlock),
          },
        ],
      });
      return raw
        .filter((l) => l.blockNumber !== null && l.transactionHash !== null && l.logIndex !== null)
        .map((l) => ({
          address: l.address,
          topics: [...l.topics],
          data: l.data,
          blockNumber: BigInt(l.blockNumber!).toString(),
          transactionHash: l.transactionHash!,
          logIndex: Number(BigInt(l.logIndex!)),
          removed: l.removed,
        }));
    },
    async getBlockTimestamp(blockNumber) {
      const key = blockNumber.toString();
      const cached = timestamps.get(key);
      if (cached !== undefined) return cached;
      const block = await client.getBlock({ blockNumber });
      if (timestamps.size > 512) timestamps.clear();
      timestamps.set(key, block.timestamp);
      return block.timestamp;
    },
    async balanceOf(token, holder, blockNumber) {
      return client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [holder],
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      });
    },
  };
}
