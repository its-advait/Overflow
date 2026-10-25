/**
 * Prints live OverflowTreasury state from Base Sepolia: balance, owner, TOKEN, floor, nodeCount and each
 * node's remaining(). Read-only.
 *
 * Usage: pnpm status [--deployments <path>]
 */
import { erc20Abi, getAddress } from "viem";
import { explorerUrl, formatUsdc, loadDeployments, overflowTreasuryAbi } from "@overflow/schemas";
import { assertChainId, loadEnv, publicClient } from "./lib/env.js";

async function main(): Promise<void> {
  loadEnv();
  const argIdx = process.argv.indexOf("--deployments");
  const d = await loadDeployments(argIdx >= 0 ? process.argv[argIdx + 1] : undefined);
  const client = publicClient();
  await assertChainId(client);

  const treasury = { address: d.treasury, abi: overflowTreasuryAbi } as const;
  const [balance, owner, token, floor, nodeCount, blockNumber] = await Promise.all([
    client.readContract({ address: d.token, abi: erc20Abi, functionName: "balanceOf", args: [d.treasury] }),
    client.readContract({ ...treasury, functionName: "owner" }),
    client.readContract({ ...treasury, functionName: "TOKEN" }),
    client.readContract({ ...treasury, functionName: "floor" }),
    client.readContract({ ...treasury, functionName: "nodeCount" }),
    client.getBlockNumber(),
  ]);

  if (getAddress(token) !== getAddress(d.token)) {
    console.error(`TOKEN() ${token} differs from deployments token ${d.token}`);
    process.exit(1);
  }

  console.log(`OverflowTreasury ${d.treasury}  (${explorerUrl("address", d.treasury)})`);
  console.log(`block        ${blockNumber}`);
  console.log(`USDC balance ${formatUsdc(balance)} USDC  (${balance.toString()} atomic)`);
  console.log(`owner        ${owner}`);
  console.log(`TOKEN        ${token}`);
  console.log(`floor        ${formatUsdc(floor)} USDC`);
  console.log(`nodeCount    ${nodeCount}`);
  console.log(`escrowFactory ${d.escrowFactory ?? "not deployed"}`);

  const rows: Record<string, string | number | boolean>[] = [];
  for (let id = 1n; id <= nodeCount; id++) {
    const [node, remaining] = await Promise.all([
      client.readContract({ ...treasury, functionName: "getNode", args: [id] }),
      client.readContract({ ...treasury, functionName: "remaining", args: [id] }),
    ]);
    rows.push({
      id: Number(id),
      key: node.key,
      parent: Number(node.parent),
      depth: Number(node.depth),
      cap: formatUsdc(node.cap),
      spent: formatUsdc(node.spent),
      remaining: formatUsdc(remaining),
      maxPerCall: formatUsdc(node.maxPerCall),
      expiry: new Date(Number(node.expiry) * 1000).toISOString(),
      paused: node.paused,
      restricted: node.restricted,
    });
  }
  if (rows.length === 0) console.log("no nodes yet");
  else console.table(rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
