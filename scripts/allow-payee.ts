/**
 * DEV ONLY. Allowlists payees on OverflowTreasury with the owner key (setAllow(payee, true)). In the demo the
 * controller signs this from Coinbase Wallet; this script SIMULATES that step and must never be presented as
 * the controller's action. Moves no USDC.
 *
 * Signing: the DEPLOYER signer (64-hex DEPLOYER_PRIVATE_KEY in .env, or DEPLOYER_ACCOUNT + DEPLOYER_PASSWORD_FILE
 * keystore) via @overflow/payment-client/keystore; the key is never logged. Refuses ATTACKER_ADDRESS.
 *
 * Usage: pnpm --filter @overflow/scripts allow-payee <address> [<address> ...]
 */
import { createWalletClient, getAddress, http, type Address } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { resolveSigner } from "@overflow/payment-client/keystore";
import { explorerUrl, loadDeployments, overflowTreasuryAbi } from "@overflow/schemas";
import { assertChainId, loadEnv, publicClient, requireEnv } from "./lib/env.js";

async function main(): Promise<void> {
  console.log("[DEV ONLY] allow-payee: SIMULATES the controller allowlisting a payee. Not for the demo.");
  loadEnv();
  const payees = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (payees.length === 0) {
    console.error("usage: pnpm --filter @overflow/scripts allow-payee <address> [<address> ...]");
    process.exit(2);
  }
  const attacker = process.env["ATTACKER_ADDRESS"]?.trim();
  for (const p of payees) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(p)) {
      console.error(`not an address: ${p}`);
      process.exit(2);
    }
    if (attacker && getAddress(p) === getAddress(attacker)) {
      console.error(`refusing to allowlist ${p}: it is the SIMULATED ATTACKER_ADDRESS`);
      process.exit(2);
    }
  }

  const d = await loadDeployments();
  const client = publicClient();
  await assertChainId(client);
  const treasury = { address: d.treasury, abi: overflowTreasuryAbi } as const;
  const owner = (await client.readContract({ ...treasury, functionName: "owner" })) as Address;
  const signer = resolveSigner({
    keyOrAddress: process.env["DEPLOYER_PRIVATE_KEY"],
    account: process.env["DEPLOYER_ACCOUNT"] ?? "overflow-deployer",
    passwordFile: process.env["DEPLOYER_PASSWORD_FILE"],
    label: "DEPLOYER",
  });
  if (getAddress(signer.account.address) !== getAddress(owner)) {
    console.error(`DEPLOYER signer ${signer.account.address} (${signer.source}) is not the treasury owner ${owner}`);
    process.exit(1);
  }
  // Same runtime object; the cast only bridges the two abitype instances pnpm installs for TS 5 and TS 7.
  const account = signer.account as unknown as PrivateKeyAccount;
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(requireEnv("BASE_SEPOLIA_RPC_URL")) });
  console.log(`owner ${owner} (${signer.source}) on treasury ${d.treasury}`);

  for (const raw of payees) {
    const payee = getAddress(raw);
    const already = (await client.readContract({ ...treasury, functionName: "allowlist", args: [payee] })) as boolean;
    if (already) {
      console.log(`${payee}: already allowlisted, skipping`);
      continue;
    }
    const { request } = await client.simulateContract({ ...treasury, functionName: "setAllow", args: [payee, true], account });
    const hash = await wallet.writeContract(request);
    console.log(`${payee}: setAllow(true) sent ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") {
      console.error(`${payee}: setAllow reverted in block ${receipt.blockNumber}: ${explorerUrl("tx", hash)}`);
      process.exit(1);
    }
    const now = (await client.readContract({ ...treasury, functionName: "allowlist", args: [payee] })) as boolean;
    console.log(`${payee}: allowlist=${now} block ${receipt.blockNumber} tx ${explorerUrl("tx", hash)}`);
    if (!now) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
