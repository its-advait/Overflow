/**
 * DEV ONLY. Moves N USDC from the deployer to the treasury so local runs have a budget.
 * In the demo the controller funds the treasury through Coinbase Wallet instead; this script
 * SIMULATES that step and must never be presented as the controller's action.
 *
 * Signing: shells out to `cast send --account <keystore> --password-file <path>` so no private key
 * is ever loaded into this process.
 *
 * Usage: pnpm dev:fund <usdc amount, e.g. 5 or 0.50>
 */
import { spawnSync } from "node:child_process";
import { erc20Abi } from "viem";
import { atomicToBigInt, explorerUrl, formatUsdc, loadDeployments, toAtomic } from "@overflow/schemas";
import { assertChainId, deployerAddress, loadEnv, publicClient, requireEnv } from "./lib/env.js";

async function main(): Promise<void> {
  console.log("[DEV ONLY] dev-fund: SIMULATES the controller funding the treasury. Not for the demo.");
  loadEnv();
  const human = process.argv[2];
  if (!human) {
    console.error("usage: pnpm dev:fund <usdc amount>");
    process.exit(2);
  }
  const amount = atomicToBigInt(toAtomic(human));
  const d = await loadDeployments();
  const client = publicClient();
  await assertChainId(client);
  const rpc = requireEnv("BASE_SEPOLIA_RPC_URL");
  const account = process.env["DEPLOYER_ACCOUNT"] ?? "overflow-deployer";
  // Without a password file, cast prompts for the keystore password on this terminal.
  const passwordFile = process.env["DEPLOYER_PASSWORD_FILE"];
  const funder = await deployerAddress();

  const funderBalance = await client.readContract({
    address: d.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [funder],
  });
  if (funderBalance < amount) {
    console.error(
      `deployer ${funder} holds ${formatUsdc(funderBalance)} USDC, needs ${formatUsdc(amount)}. ` +
        "Get Base Sepolia test USDC at https://faucet.circle.com",
    );
    process.exit(1);
  }

  console.log(`sending ${formatUsdc(amount)} USDC from ${funder} to treasury ${d.treasury} via cast (${account})`);
  const res = spawnSync(
    "cast",
    [
      "send",
      d.token,
      "transfer(address,uint256)",
      d.treasury,
      amount.toString(),
      "--account",
      account,
      ...(passwordFile ? ["--password-file", passwordFile] : []),
      "--rpc-url",
      rpc,
      "--json",
    ],
    { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
  );
  if (res.status !== 0) {
    if (res.stdout) console.error(res.stdout);
    process.exit(res.status ?? 1);
  }
  const receipt = JSON.parse(res.stdout) as { transactionHash: `0x${string}`; status: string };
  if (receipt.status !== "0x1" && receipt.status !== "1") {
    console.error(`transfer reverted: ${receipt.transactionHash}`);
    process.exit(1);
  }
  const after = await client.readContract({
    address: d.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [d.treasury],
  });
  console.log(`tx ${explorerUrl("tx", receipt.transactionHash)}`);
  console.log(`treasury balance now ${formatUsdc(after)} USDC`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
