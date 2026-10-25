import { overflowTreasuryAbi, type Address, type Deployments, type NetworkInfo } from "@overflow/schemas";
import type { ObservedTokenDomain } from "@overflow/payment-client";
import type { NetworkInfoPort } from "../api/ports.js";
import type { ChainClient } from "./client.js";

const big = (v: unknown): bigint => BigInt(v as bigint | number | string);

export interface NetworkInfoDeps {
  chain: Pick<ChainClient, "readContract" | "getBlockNumber">;
  chainId: number;
  /** True when the RPC answered anvil_nodeInfo at boot; the label a judge sees. */
  anvil: boolean;
  /** Host only (recourse/anvil.ts redact()); never the full URL. */
  rpcHost: string;
  treasury: Address;
  escrowFactory: Address | null;
  /** The USDC domain as verifyBoot observed it on this chain. */
  token: ObservedTokenDomain;
  relayer: Address;
  deployments: Pick<Deployments, "deployBlock" | "deployedAt">;
  now?: () => Date;
}

/**
 * GET /api/settings/network: the treasury's owner(), floor(), reservationWindow(), reservedTotal() and nodeCount()
 * read at one block, plus the boot-time token domain and deployment facts. eth_call views only; nothing here
 * signs, caches or guesses.
 */
export function viemNetworkInfo(deps: NetworkInfoDeps): NetworkInfoPort {
  const view = (functionName: string, blockNumber: bigint) =>
    deps.chain.readContract({ address: deps.treasury, abi: overflowTreasuryAbi, functionName, blockNumber });
  return {
    async read(): Promise<NetworkInfo> {
      const blockNumber = await deps.chain.getBlockNumber();
      const [owner, floor, reservationWindow, reservedTotal, nodeCount] = await Promise.all([
        view("owner", blockNumber),
        view("floor", blockNumber),
        view("reservationWindow", blockNumber),
        view("reservedTotal", blockNumber),
        view("nodeCount", blockNumber),
      ]);
      return {
        chainId: deps.chainId,
        network: deps.anvil ? "local Anvil fork" : "Base Sepolia",
        rpc: deps.rpcHost,
        treasury: deps.treasury,
        escrowFactory: deps.escrowFactory,
        owner: owner as Address,
        floorAtomic: big(floor).toString(),
        reservationWindowSeconds: big(reservationWindow).toString(),
        reservedTotalAtomic: big(reservedTotal).toString(),
        nodeCount: big(nodeCount).toString(),
        token: { address: deps.token.address, name: deps.token.name, version: deps.token.version, decimals: deps.token.decimals, domainSeparator: deps.token.domainSeparator },
        relayer: deps.relayer,
        blockNumber: blockNumber.toString(),
        readAt: (deps.now ?? (() => new Date()))().toISOString(),
        ...(deps.deployments.deployBlock ? { deployBlock: deps.deployments.deployBlock } : {}),
        ...(deps.deployments.deployedAt ? { deployedAt: deps.deployments.deployedAt } : {}),
      };
    },
  };
}
