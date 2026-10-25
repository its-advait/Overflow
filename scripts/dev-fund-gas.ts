/**
 * DEV ONLY. Tops up the relayer's gas: sends ETH from the deployer to the relayer when the relayer's
 * balance is below a floor. In the demo the operator funds the relayer by hand; this script SIMULATES
 * that step and must never be presented as the controller's action. Moves ETH only, never USDC.
 *
 * Signing: the DEPLOYER signer (64-hex DEPLOYER_PRIVATE_KEY in .env, or DEPLOYER_ACCOUNT + DEPLOYER_PASSWORD_FILE
 * keystore) via @overflow/payment-client/keystore; the key is never logged. The relayer address is derived the
 * same way from RELAYER_PRIVATE_KEY / RELAYER_ACCOUNT, or given with --to.
 *
 * Usage: pnpm --filter @overflow/scripts dev-fund-gas [--amount 0.005] [--min 0.002] [--to <address>]
 */
import { createWalletClient, formatEther, getAddress, http, parseEther, type Address } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { resolveSigner } from "@overflow/payment-client/keystore";
import { explorerUrl } from "@overflow/schemas";
import { assertChainId, loadEnv, publicClient, requireEnv } from "./lib/env.js";

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

async function main(): Promise<void> {
  console.log("[DEV ONLY] dev-fund-gas: SIMULATES the operator topping up the relayer's gas ETH. Not for the demo.");
  loadEnv();
  const amount = parseEther(opt("amount", "0.005"));
  const min = parseEther(opt("min", "0.002"));
  const client = publicClient();
  await assertChainId(client);

  const toOverride = opt("to", "");
  let to: Address;
  if (toOverride) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(toOverride)) {
      console.error(`--to is not an address: ${toOverride}`);
      process.exit(2);
    }
    to = getAddress(toOverride);
  } else {
    const relayer = resolveSigner({
      keyOrAddress: process.env["RELAYER_PRIVATE_KEY"],
      account: process.env["RELAYER_ACCOUNT"] ?? "overflow-relayer",
      passwordFile: process.env["RELAYER_PASSWORD_FILE"],
      label: "RELAYER",
    });
    to = getAddress(relayer.account.address);
  }

  const before = await client.getBalance({ address: to });
  if (before >= min) {
    console.log(`relayer ${to} has ${formatEther(before)} ETH (>= floor ${formatEther(min)}), nothing sent`);
    return;
  }

  const signer = resolveSigner({
    keyOrAddress: process.env["DEPLOYER_PRIVATE_KEY"],
    account: process.env["DEPLOYER_ACCOUNT"] ?? "overflow-deployer",
    passwordFile: process.env["DEPLOYER_PASSWORD_FILE"],
    label: "DEPLOYER",
  });
  // Same runtime object; the cast only bridges the two abitype instances pnpm installs for TS 5 and TS 7.
  const account = signer.account as unknown as PrivateKeyAccount;
  const funder = account.address;
  const funderEth = await client.getBalance({ address: funder });
  const gasPrice = await client.getGasPrice();
  const fee = 21_000n * gasPrice * 2n; // plain transfer, 2x headroom on the quoted price
  if (funderEth < amount + fee) {
    console.error(
      `deployer ${funder} (${signer.source}) holds ${formatEther(funderEth)} ETH, needs ${formatEther(amount)} + ~${formatEther(fee)} fee. ` +
        "Fund the deployer with Base Sepolia ETH first. Nothing sent.",
    );
    process.exit(1);
  }

  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(requireEnv("BASE_SEPOLIA_RPC_URL")) });
  console.log(`relayer ${to} has ${formatEther(before)} ETH (< floor ${formatEther(min)}); sending ${formatEther(amount)} ETH from deployer ${funder} (${signer.source})`);
  const hash = await wallet.sendTransaction({ to, value: amount });
  console.log(`transfer sent ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") {
    console.error(`transfer reverted in block ${receipt.blockNumber}: ${explorerUrl("tx", hash)}`);
    process.exit(1);
  }
  const after = await client.getBalance({ address: to });
  console.log(`block ${receipt.blockNumber} tx ${explorerUrl("tx", hash)}`);
  console.log(`relayer balance now ${formatEther(after)} ETH`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
