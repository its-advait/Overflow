import type { Address } from "viem";
import { CHAIN_ID, USDC, overflowTreasuryAbi, type Deployments } from "@overflow/schemas";
import { readTokenDomain, type ObservedTokenDomain } from "@overflow/payment-client";
import type { ChainClient } from "./client";

export class BootCheckFailed extends Error {
  constructor(public readonly problems: string[]) {
    super(`boot checks failed:\n  - ${problems.join("\n  - ")}`);
    this.name = "BootCheckFailed";
  }
}

export type BootReport = { chainId: number; token: ObservedTokenDomain; treasury: Address; escrowFactory: Address | null; blockNumber: bigint };

/**
 * Fail loudly before serving: RPC chain id, USDC domain (name/version/DOMAIN_SEPARATOR), deployments file
 * consistency, treasury code present, treasury.TOKEN() == USDC, and the factory wiring when one is recorded.
 */
export async function verifyBoot(client: ChainClient, d: Deployments): Promise<BootReport> {
  const problems: string[] = [];
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) problems.push(`RPC is chain ${chainId}, expected ${CHAIN_ID}`);
  if (d.chainId !== CHAIN_ID) problems.push(`deployments file is for chain ${d.chainId}`);
  if (d.token.toLowerCase() !== USDC.address.toLowerCase()) problems.push(`deployments token ${d.token} is not USDC ${USDC.address}`);
  if (d.usdc.toLowerCase() !== d.token.toLowerCase()) problems.push(`deployments usdc ${d.usdc} != token ${d.token}`);
  if (problems.length) throw new BootCheckFailed(problems);

  let token: ObservedTokenDomain;
  try {
    token = await readTokenDomain(client, d.token);
  } catch (e) {
    throw new BootCheckFailed([e instanceof Error ? e.message : String(e)]);
  }

  const code = await client.getCode(d.treasury);
  if (!code || code === "0x") problems.push(`no contract code at treasury ${d.treasury}`);
  else {
    const t = (await client.readContract({ address: d.treasury, abi: overflowTreasuryAbi, functionName: "TOKEN" })) as string;
    if (t.toLowerCase() !== d.token.toLowerCase()) problems.push(`treasury.TOKEN() is ${t}, deployments say ${d.token}`);
    if (d.escrowFactory) {
      const f = (await client.readContract({ address: d.treasury, abi: overflowTreasuryAbi, functionName: "escrowFactory" })) as string;
      if (f.toLowerCase() !== d.escrowFactory.toLowerCase()) problems.push(`treasury.escrowFactory() is ${f}, deployments say ${d.escrowFactory}`);
    }
  }
  if (problems.length) throw new BootCheckFailed(problems);
  return { chainId, token, treasury: d.treasury, escrowFactory: d.escrowFactory, blockNumber: await client.getBlockNumber() };
}
