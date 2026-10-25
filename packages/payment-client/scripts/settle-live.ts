// Live check on Base Sepolia: verify the USDC domain, sign a real TransferWithAuthorization with an
// agent node key (from = the treasury), then have the relayer call OverflowTreasury.settle() and
// confirm on chain that USDC consumed the nonce.
//
//   pnpm --filter @overflow/payment-client settle:live -- --to 0xPayee [--amount 10000] [--dry-run]
//
// Env (from the repo root .env): BASE_SEPOLIA_RPC_URL, AGENT_KEYS (first key signs),
// RELAYER_PRIVATE_KEY (submits settle()), and deployments/base-sepolia.json for the treasury
// address (override with --treasury 0x...). --dry-run stops after signing.
// NODE_SIGNER=cdp signs with the CDP server account CDP_ACCOUNT_NAME (pinned to CDP_ACCOUNT_ADDRESS
// when set) instead of AGENT_KEYS; the CDP SDK reads CDP_API_KEY_ID/SECRET and CDP_WALLET_SECRET itself.
//
// This script never calls USDC directly: only treasury.settle() moves funds.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { AddressSchema, CHAIN_ID, USDC, UintStringSchema, explorerUrl, loadDeployments } from "@overflow/schemas";
import { isAuthorizationLive, signTransfer, verifyTokenDomain, type NodeSigner } from "../src/index";
import { cdpSigner } from "../src/signers";

const repoRoot = resolve(import.meta.dirname, "../../..");

/** Minimal .env loader; never overrides variables already in the environment. */
function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

/** The node key: a CDP server account (NODE_SIGNER=cdp) or the first AGENT_KEYS entry. Never logged. */
async function resolveNodeAccount(): Promise<NodeSigner> {
  if (process.env["NODE_SIGNER"] === "cdp") {
    process.env["DISABLE_CDP_USAGE_TRACKING"] ??= "true";
    process.env["DISABLE_CDP_ERROR_REPORTING"] ??= "true";
    const pin = process.env["CDP_ACCOUNT_ADDRESS"];
    const resolved = await cdpSigner({
      accountName: requireEnv("CDP_ACCOUNT_NAME"),
      ...(pin ? { expectedAddress: getAddress(AddressSchema.parse(pin)) } : {}),
    });
    console.log(`node signer: ${resolved.source} (${resolved.kind})`);
    return resolved.signer;
  }
  const agentKeys = requireEnv("AGENT_KEYS").split(",").map((k) => k.trim()).filter(Boolean);
  const nodeKey = agentKeys[0];
  if (!nodeKey) throw new Error("AGENT_KEYS is empty");
  return privateKeyToAccount(nodeKey as Hex);
}

// From docs/SPEC.md "OverflowTreasury.sol" and the Leash ILeashWallet events/errors.
const TREASURY_ABI = parseAbi([
  "function settle(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes sig)",
  "function nodeOfKey(address key) view returns (uint256)",
  "function TOKEN() view returns (address)",
  "event Paid(uint256 indexed id, address indexed to, uint256 value, bytes32 nonce)",
  "error UnknownAgent(address signer)",
  "error PayeeNotAllowed(uint256 node)",
  "error OverPerCall(uint256 node)",
  "error OverBudget(uint256 node)",
  "error Expired(uint256 node)",
  "error Paused(uint256 node)",
  "error BelowFloor()",
  "error PayeeFlagged(address seller)",
]);

const USDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

async function main(): Promise<void> {
  loadEnv(resolve(repoRoot, ".env"));
  const { values } = parseArgs({
    options: {
      to: { type: "string" },
      amount: { type: "string", default: "10000" },
      treasury: { type: "string" },
      ttl: { type: "string", default: "120" },
      "dry-run": { type: "boolean", default: false },
    },
    // pnpm forwards a literal "--"; drop it so the options after it are still parsed.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    allowPositionals: true,
  });

  const rpcUrl = requireEnv("BASE_SEPOLIA_RPC_URL");
  const nodeAccount = await resolveNodeAccount();

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`RPC is chain ${chainId}, expected ${CHAIN_ID}`);

  console.log(`USDC ${USDC.address}: reading name(), version(), decimals(), DOMAIN_SEPARATOR() ...`);
  const verified = await verifyTokenDomain(publicClient);
  console.log(`  ok: ${verified.domain.name} v${verified.domain.version}, ${verified.decimals} decimals, separator ${verified.domainSeparator}`);

  const treasury: Address = values.treasury
    ? getAddress(AddressSchema.parse(values.treasury))
    : (await loadDeployments()).treasury;
  const amount = UintStringSchema.parse(values.amount);
  const ttlSeconds = Number.parseInt(values.ttl, 10);

  if (!values.to && !values["dry-run"]) throw new Error("--to <payee> is required unless --dry-run");
  const to: Address = getAddress(AddressSchema.parse(values.to ?? "0x0000000000000000000000000000000000000001"));

  const block = await publicClient.getBlock();
  const nowSeconds = Number(block.timestamp);
  console.log(`treasury ${treasury}, node key ${nodeAccount.address}, to ${to}, value ${amount} atomic, ttl ${ttlSeconds}s`);

  const signed = await signTransfer({
    nodeAccount,
    treasury,
    to,
    value: amount,
    ttlSeconds,
    nowSeconds,
    domain: verified.domain,
  });
  console.log("authorization", signed.authorizationJson);
  console.log(`digest    ${signed.digest}`);
  console.log(`signature ${signed.signature}`);
  console.log(`signer    ${signed.signer} (from = ${signed.authorization.from})`);
  const live = isAuthorizationLive(signed.authorization, block.timestamp);
  if (!live.live) throw new Error(`authorization not live at block ${block.number}: ${live.reason}`);

  if (values["dry-run"]) {
    console.log("dry run: not submitting settle()");
    return;
  }

  const relayer = privateKeyToAccount(requireEnv("RELAYER_PRIVATE_KEY") as Hex);
  const walletClient = createWalletClient({ account: relayer, chain: baseSepolia, transport: http(rpcUrl) });

  const [treasuryToken, nodeId, balanceBefore, usedBefore] = await Promise.all([
    publicClient.readContract({ address: treasury, abi: TREASURY_ABI, functionName: "TOKEN" }),
    publicClient.readContract({ address: treasury, abi: TREASURY_ABI, functionName: "nodeOfKey", args: [nodeAccount.address] }),
    publicClient.readContract({ address: USDC.address, abi: USDC_ABI, functionName: "balanceOf", args: [to] }),
    publicClient.readContract({ address: USDC.address, abi: USDC_ABI, functionName: "authorizationState", args: [treasury, signed.authorization.nonce] }),
  ]);
  if (treasuryToken.toLowerCase() !== USDC.address.toLowerCase()) throw new Error(`treasury TOKEN() is ${treasuryToken}, not USDC`);
  if (nodeId === 0n) throw new Error(`node key ${nodeAccount.address} is not registered on the treasury (nodeOfKey == 0)`);
  if (usedBefore) throw new Error("nonce already used; this cannot happen with a fresh random nonce");
  console.log(`node id ${nodeId}; payee balance before ${balanceBefore}`);

  const a = signed.authorization;
  const args = [a.to, a.value, a.validAfter, a.validBefore, a.nonce, signed.signature] as const;
  try {
    const { request } = await publicClient.simulateContract({
      account: relayer,
      address: treasury,
      abi: TREASURY_ABI,
      functionName: "settle",
      args,
    });
    const hash = await walletClient.writeContract(request);
    console.log(`settle() sent: ${explorerUrl("tx", hash)}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`settle() reverted in block ${receipt.blockNumber}: ${explorerUrl("tx", hash)}`);

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== treasury.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: TREASURY_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === "Paid") console.log("Paid event", ev.args);
      } catch {
        /* not a Paid log */
      }
    }

    const [balanceAfter, usedAfter] = await Promise.all([
      publicClient.readContract({ address: USDC.address, abi: USDC_ABI, functionName: "balanceOf", args: [to] }),
      publicClient.readContract({ address: USDC.address, abi: USDC_ABI, functionName: "authorizationState", args: [treasury, a.nonce] }),
    ]);
    console.log(`payee balance after ${balanceAfter} (delta ${balanceAfter - balanceBefore}); USDC authorizationState(treasury, nonce) = ${usedAfter}`);
    if (!usedAfter || balanceAfter - balanceBefore !== a.value) {
      throw new Error("chain state does not show the transfer; do not treat this payment as settled");
    }
    console.log(`confirmed on chain in block ${receipt.blockNumber}: ${explorerUrl("tx", hash)}`);
  } catch (err) {
    if (err instanceof BaseError) {
      const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError) {
        const name = revert.data?.errorName ?? revert.reason ?? "unknown";
        const revertArgs = revert.data?.args ? JSON.stringify(revert.data.args, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : "";
        throw new Error(`settle() reverted: ${name}${revertArgs} (digest ${signed.digest}; nothing moved)`);
      }
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
