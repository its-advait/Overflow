import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  encodeEventTopics,
  encodeAbiParameters,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hono } from "hono";
import { overflowTreasuryAbi, parseDeployments, USDC } from "@overflow/schemas";
import type { ChainClient } from "../chain/client";
import { createFacilitatorApp } from "./app";
import { createBus } from "./events";
import { createRelayer } from "./relayer";
import { MemoryStore } from "./store";

export const TREASURY = "0xd3A74fA991CA0B5627d30EF27dC699C134848291" as const;
export const PAYEE = "0x1111111111111111111111111111111111111111" as const;
export const ATTACKER = "0x2222222222222222222222222222222222222222" as const;
export const RELAYER = privateKeyToAccount(`0x${"7e1a".padStart(64, "0")}`);
export const NODE = privateKeyToAccount(`0x${"a11ce".padStart(64, "0")}`);
export const NOW = new Date("2026-10-24T12:00:00Z");
export const DEMO_TOKEN = "demo-token-at-least-16-chars";

export const deployments = parseDeployments({
  chainId: 84532,
  token: USDC.address,
  usdc: USDC.address,
  treasury: TREASURY,
  escrowFactory: null,
  escrowImplementation: null,
  txs: {},
});

export function revert(errorName: string, args: unknown[] = []): Error {
  const data = encodeErrorResult({ abi: overflowTreasuryAbi, errorName: errorName as never, args: args as never });
  const inner = new ContractFunctionRevertedError({ abi: overflowTreasuryAbi, data, functionName: "settle" });
  return new ContractFunctionExecutionError(inner, { abi: overflowTreasuryAbi, functionName: "settle", args: [] });
}

export function revertString(message: string): Error {
  const data = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }], args: [message] });
  const inner = new ContractFunctionRevertedError({ abi: overflowTreasuryAbi, data, functionName: "transferWithAuthorization" });
  return new ContractFunctionExecutionError(inner, { abi: overflowTreasuryAbi, functionName: "transferWithAuthorization", args: [] });
}

export function paidLog(id: bigint, to: Address, value: bigint, nonce: Hex, txHash: Hex, blockNumber = 100n): Log {
  const topics = encodeEventTopics({ abi: overflowTreasuryAbi, eventName: "Paid", args: { id, to } });
  return { address: TREASURY, topics, data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [value, nonce]), blockNumber, transactionHash: txHash, logIndex: 0, transactionIndex: 0, blockHash: `0x${"bb".repeat(32)}`, removed: false } as Log;
}

export function reservedLog(digest: Hex, id: bigint, to: Address, value: bigint, validBefore: bigint, nonce: Hex, txHash: Hex): Log {
  const topics = encodeEventTopics({ abi: overflowTreasuryAbi, eventName: "Reserved", args: { digest, id, to } });
  return { address: TREASURY, topics, data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }], [value, validBefore, nonce]), blockNumber: 100n, transactionHash: txHash, logIndex: 0, transactionIndex: 0, blockHash: `0x${"bb".repeat(32)}`, removed: false } as Log;
}

export function releasedLog(digest: Hex, refunded: boolean, txHash: Hex): Log {
  const topics = encodeEventTopics({ abi: overflowTreasuryAbi, eventName: "ReservationReleased", args: { digest } });
  return { address: TREASURY, topics, data: encodeAbiParameters([{ type: "bool" }], [refunded]), blockNumber: 100n, transactionHash: txHash, logIndex: 0, transactionIndex: 0, blockHash: `0x${"bb".repeat(32)}`, removed: false } as Log;
}

export function nodeCreatedLog(id: bigint, parent: bigint, key: Address, txHash: Hex): Log {
  const topics = encodeEventTopics({ abi: overflowTreasuryAbi, eventName: "NodeCreated", args: { id, parent } });
  return { address: TREASURY, topics, data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [key, 10n, 5n, 99n]), blockNumber: 100n, transactionHash: txHash, logIndex: 0, transactionIndex: 0, blockHash: `0x${"bb".repeat(32)}`, removed: false } as Log;
}

export function nodePausedLog(id: bigint, by: Address, txHash: Hex): Log {
  const topics = encodeEventTopics({ abi: overflowTreasuryAbi, eventName: "NodePaused", args: { id } });
  return { address: TREASURY, topics, data: encodeAbiParameters([{ type: "address" }], [by]), blockNumber: 100n, transactionHash: txHash, logIndex: 0, transactionIndex: 0, blockHash: `0x${"bb".repeat(32)}`, removed: false } as Log;
}

export function receipt(hash: Hex, status: "success" | "reverted", logs: Log[] = [], blockNumber = 100n): TransactionReceipt {
  return { transactionHash: hash, status, logs, blockNumber, from: RELAYER.address, to: TREASURY, gasUsed: 100000n, cumulativeGasUsed: 100000n, effectiveGasPrice: 1n, contractAddress: null, logsBloom: "0x", transactionIndex: 0, type: "eip1559", blockHash: `0x${"bb".repeat(32)}` } as TransactionReceipt;
}

export type FakeChain = ChainClient & {
  sent: Array<{ to: Address; data: Hex; nonce: number; gas?: bigint }>;
  simulate: (args: { functionName: string; address: Address; args?: readonly unknown[]; blockNumber?: bigint }) => unknown | Promise<unknown>;
  receipts: Record<Hex, TransactionReceipt>;
  reads: Record<string, unknown>;
  logs: Log[];
  nextHash: Hex[];
  balance: bigint;
  head: bigint;
  nonce: number;
  receiptError?: Error;
};

export function fakeChain(): FakeChain {
  const f: FakeChain = {
    sent: [],
    simulate: () => undefined,
    receipts: {},
    reads: { TOKEN: USDC.address, nodeOfKey: 1n, authorizationState: false, escrowFactory: "0x0000000000000000000000000000000000000000" },
    logs: [],
    nextHash: [],
    balance: 10n ** 18n,
    head: 100n,
    nonce: 7,
    getChainId: async () => 84532,
    getCode: async () => "0x6001",
    getBalance: async () => f.balance,
    getBlockNumber: async () => f.head,
    readContract: async ({ functionName }) => f.reads[functionName],
    simulateContract: async (a) => f.simulate(a),
    getTransactionCount: async () => f.nonce,
    sendTransaction: async (a) => {
      f.sent.push(a);
      const h = f.nextHash.shift() ?? (`0x${(f.sent.length).toString(16).padStart(64, "0")}` as Hex);
      return h;
    },
    waitForTransactionReceipt: async ({ hash }) => {
      if (f.receiptError) throw f.receiptError;
      return f.receipts[hash] ?? receipt(hash, "success");
    },
    getLogs: async () => f.logs,
  };
  return f;
}

export function makeApp(chain: FakeChain, opts: { demo?: boolean } = {}) {
  const bus = createBus({ now: () => NOW });
  const store = new MemoryStore(() => NOW);
  const relayer = createRelayer({ client: chain, address: RELAYER.address, receiptTimeoutMs: 1000 });
  const app = createFacilitatorApp(
    { client: chain, relayer, store, bus, deployments, treasury: TREASURY, usdc: USDC.address, demoMode: !!opts.demo, ...(opts.demo ? { demoToken: DEMO_TOKEN } : {}), now: () => NOW, log: () => {} },
    { heartbeatMs: 50 },
  );
  return { app, bus, store, relayer };
}

export const nowSec = BigInt(Math.floor(NOW.getTime() / 1000));
export function auth(to: Address = PAYEE, value = "50000", nonce: Hex = `0x${"ab".repeat(32)}`): { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex } {
  return { from: TREASURY, to, value, validAfter: (nowSec - 5n).toString(), validBefore: (nowSec + 120n).toString(), nonce };
}

export async function post(app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { original?: Record<string, unknown>; decoded?: Record<string, unknown>; error?: Record<string, unknown> } };
}
