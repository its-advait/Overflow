import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeploymentsSchema, USDC, overflowEscrowFactoryAbi, overflowTreasuryAbi, type Address, type Hex } from "@overflow/schemas";
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, http, keccak256, parseAbi, toHex, type Abi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { assertAnvil, redact, rpc } from "../src/recourse/anvil.js";

// ---------------------------------------------------------------------------
// Provision a LOCAL Anvil fork of Base Sepolia for the recourse demo:
//   1. refuse unless the RPC is Anvil on chain 84532 (never Base Sepolia itself);
//   2. deploy OverflowTreasury(USDC, owner) and OverflowEscrowFactory from contracts/out
//      with viem (never `forge script --broadcast`, which would overwrite the real
//      Base Sepolia broadcast record; `pnpm contracts:export` is never run);
//   3. setEscrowFactory, createRoot(root node key, 100 USDC cap, 20 USDC per call, 30 days);
//   4. mint USDC to the treasury (100) and to each SIMULATED seller (10, for bonds) by
//      impersonating USDC's masterMinter, falling back to a storage write;
//   5. write apps/service/.anvil/deployments.json and .anvil/service.env (both gitignored).
// Accounts are Anvil's public dev mnemonic ("test test ... junk"); no key is hardcoded and
// none is printed. Usage: pnpm --filter @overflow/service anvil:provision
// ---------------------------------------------------------------------------

const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const RPC = process.env["ANVIL_RPC_URL"] ?? "http://127.0.0.1:8545";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT_DIR = resolve(ROOT, "apps/service/.anvil");
const TREASURY_USDC = 100_000_000n;
const SELLER_USDC = 10_000_000n;
const ROOT_CAP = 100_000_000n;
const ROOT_MAX_PER_CALL = 20_000_000n;

const usdcAbi = parseAbi([
  "function masterMinter() view returns (address)",
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

interface Artifact {
  abi: Abi;
  bytecode: { object: Hex };
}
const artifact = (name: string): Artifact => {
  const path = resolve(ROOT, `contracts/out/${name}.sol/${name}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Artifact;
  } catch {
    throw new Error(`missing ${path}; run pnpm contracts:build first`);
  }
};

const log = (line: string) => console.log(line);

async function main(): Promise<void> {
  await assertAnvil(RPC);
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const chainId = await pub.getChainId();
  if (chainId !== 84532) throw new Error(`refused: Anvil reports chain ${chainId}; start it with scripts/anvil-up.sh (--chain-id 84532 fork)`);
  const usdcCode = await pub.getCode({ address: USDC.address });
  if (!usdcCode || usdcCode === "0x") throw new Error(`refused: no USDC code at ${USDC.address}; Anvil must fork Base Sepolia`);

  // Anvil's dev accounts by index: 0 deployer+owner, 1 relayer, 2 root node key, 3..5 SIMULATED sellers.
  const acct = (i: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
  const [deployer, relayer, rootNode, honest, ghost, swap] = [0, 1, 2, 3, 4, 5].map(acct);
  const wallet = createWalletClient({ account: deployer!, chain: baseSepolia, transport: http(RPC) });
  const privateKey = (i: number): Hex => toHex(acct(i).getHdKey().privateKey!);
  log(`anvil ${redact(RPC)} chain ${chainId}, USDC ${USDC.address}`);
  log(`deployer/owner ${deployer!.address}  relayer ${relayer!.address}  root node key ${rootNode!.address}`);
  log(`SIMULATED sellers: honest ${honest!.address}  ghost ${ghost!.address}  swap ${swap!.address}`);

  const deploy = async (name: string, args: readonly unknown[]): Promise<{ address: Address; hash: Hex; block: bigint }> => {
    const a = artifact(name);
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deployment reverted (${hash})`);
    log(`${name} deployed at ${r.contractAddress} (tx ${hash}, block ${r.blockNumber})`);
    return { address: r.contractAddress, hash, block: r.blockNumber };
  };
  const send = async (label: string, to: Address, abi: Abi | readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> => {
    const hash = await wallet.writeContract({ address: to, abi, functionName, args } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
    log(`${label} confirmed (tx ${hash})`);
    return hash;
  };

  const treasury = await deploy("OverflowTreasury", [USDC.address, deployer!.address]);
  const factory = await deploy("OverflowEscrowFactory", []);
  const implementation = (await pub.readContract({ address: factory.address, abi: overflowEscrowFactoryAbi, functionName: "implementation" })) as Address;
  const txs: Record<string, Hex> = { treasury: treasury.hash, escrowFactory: factory.hash };
  txs["setEscrowFactory"] = await send("treasury.setEscrowFactory", treasury.address, overflowTreasuryAbi, "setEscrowFactory", [factory.address]);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  txs["createRoot"] = await send(`treasury.createRoot(root node key, cap ${ROOT_CAP}, per call ${ROOT_MAX_PER_CALL})`, treasury.address, overflowTreasuryAbi, "createRoot", [rootNode!.address, ROOT_CAP, ROOT_MAX_PER_CALL, expiry]);
  const nodeId = await pub.readContract({ address: treasury.address, abi: overflowTreasuryAbi, functionName: "nodeOfKey", args: [rootNode!.address] });
  log(`root node id ${nodeId} for key ${rootNode!.address}`);

  // USDC for the demo: impersonate masterMinter (Anvil only), else write the balance slot directly.
  const mint = async (to: Address, amount: bigint, label: string): Promise<void> => {
    const before = (await pub.readContract({ address: USDC.address, abi: usdcAbi, functionName: "balanceOf", args: [to] })) as bigint;
    const target = before + amount;
    try {
      const masterMinter = (await pub.readContract({ address: USDC.address, abi: usdcAbi, functionName: "masterMinter" })) as Address;
      await rpc(RPC, "anvil_impersonateAccount", [masterMinter]);
      await rpc(RPC, "anvil_setBalance", [masterMinter, toHex(10n ** 18n)]);
      const configure = encodeFunctionData({ abi: usdcAbi, functionName: "configureMinter", args: [deployer!.address, 2n ** 255n] });
      const h1 = (await rpc(RPC, "eth_sendTransaction", [{ from: masterMinter, to: USDC.address, data: configure, gas: toHex(200_000n) }])) as Hex;
      const r1 = await pub.waitForTransactionReceipt({ hash: h1 });
      await rpc(RPC, "anvil_stopImpersonatingAccount", [masterMinter]);
      if (r1.status !== "success") throw new Error("configureMinter reverted");
      await send(`usdc.mint(${label}, ${amount})`, USDC.address, usdcAbi, "mint", [to, amount]);
    } catch (e) {
      log(`masterMinter path failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}); writing the balance slot instead`);
      let done = false;
      for (let slot = 0; slot < 40 && !done; slot++) {
        const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, BigInt(slot)]));
        const original = (await rpc(RPC, "eth_getStorageAt", [USDC.address, key, "latest"])) as Hex;
        await rpc(RPC, "anvil_setStorageAt", [USDC.address, key, toHex(target, { size: 32 })]);
        const after = (await pub.readContract({ address: USDC.address, abi: usdcAbi, functionName: "balanceOf", args: [to] })) as bigint;
        if (after === target) done = true;
        else await rpc(RPC, "anvil_setStorageAt", [USDC.address, key, original]);
      }
      if (!done) throw new Error("could not find USDC's balance slot; mint failed");
    }
    const after = (await pub.readContract({ address: USDC.address, abi: usdcAbi, functionName: "balanceOf", args: [to] })) as bigint;
    if (after !== target) throw new Error(`${label}: balance ${after}, expected ${target}`);
    log(`${label} ${to} holds ${after} atomic USDC`);
  };
  await mint(treasury.address, TREASURY_USDC, "treasury");
  for (const [name, a] of [["honest seller", honest!], ["ghost seller", ghost!], ["swap seller", swap!]] as const) await mint(a.address, SELLER_USDC, name);

  mkdirSync(OUT_DIR, { recursive: true });
  const deployments = DeploymentsSchema.parse({
    chainId: 84532,
    token: USDC.address,
    usdc: USDC.address,
    treasury: treasury.address,
    escrowFactory: factory.address,
    escrowImplementation: implementation,
    owner: deployer!.address,
    deployer: deployer!.address,
    deployBlock: treasury.block.toString(),
    deployedAt: new Date().toISOString(),
    txs,
  });
  const deploymentsPath = resolve(OUT_DIR, "deployments.json");
  writeFileSync(deploymentsPath, `${JSON.stringify({ simulated: true, note: "LOCAL ANVIL FORK of Base Sepolia; not a real deployment", ...deployments }, null, 2)}\n`);
  log(`wrote ${deploymentsPath}`);

  // Service env for the run: Anvil dev keys (public mnemonic) for the relayer, the root node and the sellers. Never printed.
  const envPath = resolve(OUT_DIR, "service.env");
  const lines = [
    "# Generated by anvil-provision for the LOCAL Anvil fork. Gitignored. Keys are Anvil's public dev accounts.",
    `BASE_SEPOLIA_RPC_URL=${RPC}`,
    `OVERFLOW_DEPLOYMENTS_PATH=${deploymentsPath}`,
    `RELAYER_PRIVATE_KEY=${privateKey(1)}`,
    `AGENT_ROOT_KEY=${privateKey(2)}`,
    `RECOURSE_SELLER_KEYS=${privateKey(3)},${privateKey(4)},${privateKey(5)}`,
    "RECOURSE_ANVIL_RUN=1",
    "INDEXER_POLL_MS=1000",
    "EVENTS_POLL_MS=1000",
    "SERVICE_URL=http://localhost:4000",
    "",
  ];
  writeFileSync(envPath, lines.join("\n"));
  chmodSync(envPath, 0o600);
  log(`wrote ${envPath} (names: ${lines.slice(1, -1).map((l) => l.split("=")[0]).join(", ")})`);
  log("next: set -a; source apps/service/.anvil/service.env; set +a; pnpm --filter @overflow/service dev");
}

main().catch((e) => {
  console.error(`anvil-provision: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
