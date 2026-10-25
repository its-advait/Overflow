import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/**
 * The slice of viem the facilitator uses, as an interface so route tests pass a fake. Every method maps 1:1 onto
 * a viem public/wallet client call; viemChainClient() is the only production implementation.
 */
export interface ChainClient {
  getChainId(): Promise<number>;
  getCode(address: Address): Promise<Hex | undefined>;
  getBalance(address: Address): Promise<bigint>;
  getBlockNumber(): Promise<bigint>;
  readContract(args: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown>;
  /** eth_call of a write; throws viem's ContractFunctionExecutionError on revert. */
  simulateContract(args: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[]; account: Address; blockNumber?: bigint }): Promise<unknown>;
  getTransactionCount(address: Address, blockTag: "pending" | "latest"): Promise<number>;
  /** Signs with the relayer account and broadcasts; returns the tx hash. */
  sendTransaction(args: { to: Address; data: Hex; nonce: number; gas?: bigint }): Promise<Hex>;
  waitForTransactionReceipt(args: { hash: Hex; timeoutMs: number }): Promise<TransactionReceipt>;
  /** Logs of one or more contracts; `event` + `args` add a topic filter (e.g. USDC Transfer to a set of escrows). */
  getLogs(args: { address: Address | Address[]; fromBlock: bigint; toBlock: bigint; event?: AbiEvent; args?: Record<string, unknown> }): Promise<Log[]>;
}

export function viemChainClient(rpcUrl: string, account: PrivateKeyAccount): ChainClient {
  const pub = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
  return {
    getChainId: () => pub.getChainId(),
    getCode: (address) => pub.getCode({ address }),
    getBalance: (address) => pub.getBalance({ address }),
    getBlockNumber: () => pub.getBlockNumber(),
    readContract: (a) => pub.readContract(a as never),
    simulateContract: (a) => pub.simulateContract(a as never),
    getTransactionCount: (address, blockTag) => pub.getTransactionCount({ address, blockTag }),
    sendTransaction: ({ to, data, nonce, gas }) => wallet.sendTransaction({ to, data, nonce, ...(gas !== undefined ? { gas } : {}) }),
    waitForTransactionReceipt: ({ hash, timeoutMs }) => pub.waitForTransactionReceipt({ hash, timeout: timeoutMs }),
    getLogs: ({ address, fromBlock, toBlock, event, args }) =>
      pub.getLogs({ address, fromBlock, toBlock, ...(event ? { event, args } : {}) } as never) as Promise<Log[]>,
  };
}
