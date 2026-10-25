/**
 * DEV ONLY. Moves N USDC from the deployer to the treasury so local runs have a budget.
 * In the demo the controller funds the treasury through Coinbase Wallet instead; this script
 * SIMULATES that step and must never be presented as the controller's action.
 *
 * Signing: a 64-hex DEPLOYER_PRIVATE_KEY in .env is used in-process via @overflow/payment-client/keystore
 * (never logged); otherwise shells out to `cast send --account <keystore> --password-file <path>` so no
 * private key is loaded into this process.
 *
 * Usage: pnpm dev:fund <usdc amount, e.g. 5 or 0.50> [--to <address>]
 *   --to (DEV ONLY): send to another address instead of the treasury, e.g. bond USDC for a SIMULATED Recourse
 *   seller key (SELLER_KEYS). Seller keys hold gas ETH and bond USDC only.
 */
import { spawnSync } from "node:child_process";
import { createWalletClient, erc20Abi, getAddress, http } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { resolveSigner } from "@overflow/payment-client/keystore";
import { atomicToBigInt, explorerUrl, formatUsdc, loadDeployments, toAtomic } from "@overflow/schemas";
import { assertChainId, deployerAddress, loadEnv, publicClient, requireEnv } from "./lib/env.js";

async function main(): Promise<void> {
  console.log("[DEV ONLY] dev-fund: SIMULATES the controller funding the treasury. Not for the demo.");
  loadEnv();
  const args = process.argv.slice(2);
  const toIndex = args.indexOf("--to");
  const toOverride = toIndex >= 0 ? args[toIndex + 1] : undefined;
  const human = args.find((a, i) => !a.startsWith("--") && i !== toIndex + 1);
  if (!human) {
    console.error("usage: pnpm dev:fund <usdc amount> [--to <address>]");
    process.exit(2);
  }
  const amount = atomicToBigInt(toAtomic(human));
  const d = await loadDeployments();
  let recipient: `0x${string}` = d.treasury;
  if (toIndex >= 0) {
    if (!toOverride || !/^0x[0-9a-fA-F]{40}$/.test(toOverride)) {
      console.error(`--to is not an address: ${toOverride ?? "(missing)"}`);
      process.exit(2);
    }
    recipient = getAddress(toOverride);
    console.log(`[DEV ONLY] --to ${recipient}: funding this address instead of the treasury (e.g. a SIMULATED seller's bond USDC)`);
  }
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

  const txHash = /^0x[0-9a-fA-F]{64}$/.test(process.env["DEPLOYER_PRIVATE_KEY"] ?? "")
    ? await sendWithEnvKey(client, d.token, recipient, amount, funder, rpc)
    : sendWithCast(d.token, recipient, amount, funder, account, passwordFile, rpc);
  const after = await client.readContract({
    address: d.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [recipient],
  });
  console.log(`tx ${explorerUrl("tx", txHash)}`);
  console.log(`${recipient === d.treasury ? "treasury" : recipient} balance now ${formatUsdc(after)} USDC`);
}

type Client = ReturnType<typeof publicClient>;

/** Signs transfer(treasury, amount) in-process with the 64-hex DEPLOYER_PRIVATE_KEY; the key is never printed. */
async function sendWithEnvKey(
  client: Client,
  token: `0x${string}`,
  treasury: `0x${string}`,
  amount: bigint,
  funder: `0x${string}`,
  rpc: string,
): Promise<`0x${string}`> {
  const signer = resolveSigner({ keyOrAddress: process.env["DEPLOYER_PRIVATE_KEY"], label: "DEPLOYER" });
  // Same runtime object; the cast only bridges the two abitype instances pnpm installs for TS 5 and TS 7.
  const acct = signer.account as unknown as PrivateKeyAccount;
  if (acct.address.toLowerCase() !== funder.toLowerCase()) {
    console.error(`DEPLOYER_PRIVATE_KEY derives ${acct.address}, but DEPLOYER_ADDRESS says ${funder}`);
    process.exit(2);
  }
  const wallet = createWalletClient({ account: acct, chain: baseSepolia, transport: http(rpc) });
  console.log(`sending ${formatUsdc(amount)} USDC from ${funder} to ${treasury} (${signer.source})`);
  const { request } = await client.simulateContract({
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [treasury, amount],
    account: acct,
  });
  const hash = await wallet.writeContract(request);
  console.log(`transfer sent ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") {
    console.error(`transfer reverted in block ${receipt.blockNumber}: ${explorerUrl("tx", hash)}`);
    process.exit(1);
  }
  console.log(`confirmed in block ${receipt.blockNumber}`);
  return hash;
}

/** Signs through the Foundry keystore via cast; no private key enters this process. */
function sendWithCast(
  token: `0x${string}`,
  treasury: `0x${string}`,
  amount: bigint,
  funder: `0x${string}`,
  account: string,
  passwordFile: string | undefined,
  rpc: string,
): `0x${string}` {
  console.log(`sending ${formatUsdc(amount)} USDC from ${funder} to ${treasury} via cast (${account})`);
  const res = spawnSync(
    "cast",
    [
      "send",
      token,
      "transfer(address,uint256)",
      treasury,
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
  return receipt.transactionHash;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
