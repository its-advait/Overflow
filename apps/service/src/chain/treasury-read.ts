import { overflowTreasuryAbi, type Address } from "@overflow/schemas";
import type { TreasuryReadPort } from "../api/ports.js";
import { readNode, type NodeReader } from "../orchestration/delegation.js";
import type { ChainClient } from "./client.js";

const big = (v: unknown): bigint => BigInt(v as bigint | number | string);

/**
 * TreasuryReadPort over the service's viem client: eth_call view functions only
 * (nodeCount, getNode, remaining, allowlist, nodeAllow). The client's signing
 * account is never used here; the port cannot move or reserve funds.
 */
export function viemTreasuryRead(chain: NodeReader & Pick<ChainClient, "getBlockNumber">, treasury: Address): TreasuryReadPort {
  const view = (functionName: string, args: readonly unknown[] = []) =>
    chain.readContract({ address: treasury, abi: overflowTreasuryAbi, functionName, args });
  return {
    blockNumber: () => chain.getBlockNumber(),
    nodeCount: async () => big(await view("nodeCount")),
    getNode: (id) => readNode(chain, treasury, id),
    remaining: async (id) => big(await view("remaining", [id])),
    allowlist: async (payee) => Boolean(await view("allowlist", [payee])),
    nodeAllow: async (id, payee) => Boolean(await view("nodeAllow", [id, payee])),
  };
}
