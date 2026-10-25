import { overflowEscrowAbi, overflowEscrowFactoryAbi, type Address, type Hex } from "@overflow/schemas";
import { encodeFunctionData, erc20Abi } from "viem";
import type { ChainClient } from "../../chain/client.js";
import type { Relayer } from "../../facilitator/relayer.js";
import type { OrderTermsWire } from "./protocol.js";

// ---------------------------------------------------------------------------
// The chain surface the SIMULATED Recourse sellers use, as an interface so
// tests pass a fake (FakeRecourseChain in chain.test-util.ts). Writes go
// through one relayer per seller address (one nonce manager per key); every
// write is simulated first and an `unknown` outcome is never retried with a
// new nonce. The seller key signs inside the ChainClient; nothing here sees it.
// ---------------------------------------------------------------------------

export const ESCROW_STATUS = ["Created", "Funded", "Revealed", "Settled", "Refunded"] as const;
export type EscrowStatusName = (typeof ESCROW_STATUS)[number];

export type TxOutcome =
  | { status: "success"; hash: Hex; blockNumber: bigint }
  | { status: "reverted"; hash: Hex; blockNumber: bigint }
  | { status: "unknown"; hash: Hex; error: string }
  /** The simulation reverted; nothing was sent. */
  | { status: "simulation-reverted"; error: string };

export interface RecourseChainReads {
  predict(orderId: Hex, termsHash: Hex): Promise<Address>;
  isEscrow(address: Address): Promise<boolean>;
  provenCheats(seller: Address): Promise<bigint>;
  status(escrow: Address): Promise<EscrowStatusName>;
  /** Unix seconds; 0 before the reveal. */
  challengeEnd(escrow: Address): Promise<bigint>;
  usdcBalance(address: Address): Promise<bigint>;
  /** Unix seconds of the latest block (the contracts compare against block.timestamp). */
  blockTimestamp(): Promise<bigint>;
}

/** Writes signed by one seller key. */
export interface RecourseChainWrites {
  readonly sellerAddress: Address;
  create(terms: OrderTermsWire): Promise<TxOutcome>;
  transferUsdc(to: Address, amount: bigint): Promise<TxOutcome>;
  markFunded(escrow: Address): Promise<TxOutcome>;
  revealKey(escrow: Address, key: Hex): Promise<TxOutcome>;
  finalizePayout(escrow: Address): Promise<TxOutcome>;
}

export interface RecourseChain extends RecourseChainReads, RecourseChainWrites {}

export function termsToStruct(t: OrderTermsWire) {
  return {
    orderId: t.orderId,
    buyer: t.buyer,
    seller: t.seller,
    token: t.token,
    amount: BigInt(t.amount),
    bond: BigInt(t.bond),
    termsHash: t.termsHash,
    manifestHash: t.manifestHash,
    rootPlain: t.rootPlain,
    rootCipher: t.rootCipher,
    keyCommitment: t.keyCommitment,
    revealDeadline: BigInt(t.revealDeadline),
    challengeWindow: BigInt(t.challengeWindow),
    sourceKey: t.sourceKey,
    minTimestamp: BigInt(t.minTimestamp),
    chunkCount: t.chunkCount,
  } as const;
}

export function viemRecourseReads(client: ChainClient, factory: Address, usdc: Address): RecourseChainReads {
  const factoryRead = (functionName: string, args: readonly unknown[]) =>
    client.readContract({ address: factory, abi: overflowEscrowFactoryAbi, functionName, args });
  const escrowRead = (escrow: Address, functionName: string) =>
    client.readContract({ address: escrow, abi: overflowEscrowAbi, functionName, args: [] });
  return {
    predict: async (orderId, termsHash) => (await factoryRead("predict", [orderId, termsHash])) as Address,
    isEscrow: async (address) => (await factoryRead("isEscrow", [address])) as boolean,
    provenCheats: async (seller) => (await factoryRead("provenCheats", [seller])) as bigint,
    status: async (escrow) => ESCROW_STATUS[Number(await escrowRead(escrow, "status"))] ?? "Created",
    challengeEnd: async (escrow) => (await escrowRead(escrow, "challengeEnd")) as bigint,
    usdcBalance: async (address) => (await client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] })) as bigint,
    blockTimestamp: async () => BigInt(Math.floor(Date.now() / 1000)),
  };
}

/**
 * Production chain for one seller key: `client` and `relayer` are bound to that key's account.
 * `blockTimestamp` is the local clock (Base Sepolia blocks every 2 s); callers keep a safety margin.
 */
export function viemRecourseChain(opts: { client: ChainClient; relayer: Relayer; factory: Address; usdc: Address }): RecourseChain {
  const { client, relayer, factory, usdc } = opts;
  const reads = viemRecourseReads(client, factory, usdc);
  const write = async (to: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[], label: string): Promise<TxOutcome> => {
    try {
      await client.simulateContract({ address: to, abi, functionName, args, account: relayer.address });
    } catch (e) {
      return { status: "simulation-reverted", error: e instanceof Error ? e.message : String(e) };
    }
    const data = encodeFunctionData({ abi, functionName, args } as unknown as Parameters<typeof encodeFunctionData>[0]);
    const r = await relayer.submit({ to, data, label });
    if (r.status === "unknown") return { status: "unknown", hash: r.hash, error: r.error };
    return { status: r.status, hash: r.hash, blockNumber: r.receipt.blockNumber };
  };
  return {
    ...reads,
    sellerAddress: relayer.address,
    create: (terms) => write(factory, overflowEscrowFactoryAbi, "create", [termsToStruct(terms)], `recourse create ${terms.orderId.slice(0, 10)}`),
    transferUsdc: (to, amount) => write(usdc, erc20Abi, "transfer", [to, amount], `recourse bond -> ${to.slice(0, 10)}`),
    markFunded: (escrow) => write(escrow, overflowEscrowAbi, "markFunded", [], `recourse markFunded ${escrow.slice(0, 10)}`),
    revealKey: (escrow, key) => write(escrow, overflowEscrowAbi, "revealKey", [key], `recourse revealKey ${escrow.slice(0, 10)}`),
    finalizePayout: (escrow) => write(escrow, overflowEscrowAbi, "finalizePayout", [], `recourse finalizePayout ${escrow.slice(0, 10)}`),
  };
}
