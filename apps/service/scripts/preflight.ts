/**
 * Read-only preflight for the live mission run (P6.3 DONE WHEN). Derives PUBLIC addresses from the env exactly
 * as the service does (keys are never printed), then checks the treasury state they need:
 *   pnpm --filter @overflow/service preflight [--budget 5] [--require-allow]
 * Exit 0 when every required row passes. Nothing here signs or sends.
 */
import { erc20Abi, createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { resolveSigner } from "@overflow/payment-client/keystore";
import { explorerUrl, formatUsdc, loadDeployments, overflowTreasuryAbi, toAtomic } from "@overflow/schemas";
import { loadEnv, readConfig } from "../src/config.js";
import { resolveAgentKeys } from "../src/orchestration/agent-keys.js";
import { ROLES } from "../src/orchestration/delegation-plan.js";
import { resolveSellerConfig } from "../src/sellers/config.js";
import { SEARCH_PRICE_ATOMIC } from "../src/sellers/prices.js";
import { resolveRecourseConfig } from "../src/sellers/recourse/config.js";

/** Cheapest SIMULATED Recourse listing (listing-national-monthly-2021-2022: 4 USDC); its bond is bps of this. */
const CHEAPEST_RECOURSE_PRICE = BigInt(toAtomic("4"));
const MIN_SELLER_GAS_WEI = 500_000_000_000_000n; // 0.0005 ETH

type Row = { check: string; status: "PASS" | "FAIL" | "WARN" | "INFO"; detail: string };
const rows: Row[] = [];
const add = (check: string, ok: boolean | "warn" | "info", detail: string) =>
  rows.push({ check, status: ok === true ? "PASS" : ok === false ? "FAIL" : ok === "warn" ? "WARN" : "INFO", detail });

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const requireAllow = args.includes("--require-allow");
const budget = BigInt(toAtomic(opt("budget", "5")));

async function main(): Promise<void> {
  loadEnv();
  // The service's own config parser decides whether it can boot; report its verdict as a row so the chain
  // checks below still run when, say, only the relayer signer is missing.
  let config: ReturnType<typeof readConfig> | null = null;
  try {
    config = readConfig();
    add("service config (readConfig)", true, "parses");
  } catch (e) {
    add("service config (readConfig)", false, e instanceof Error ? e.message : String(e));
  }
  const rpcUrl = config?.rpcUrl ?? process.env["BASE_SEPOLIA_RPC_URL"];
  if (!rpcUrl) throw new Error("BASE_SEPOLIA_RPC_URL unset");
  const d = await loadDeployments(config?.deploymentsPath ?? process.env["OVERFLOW_DEPLOYMENTS_PATH"] ?? undefined);
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const demoMode = config ? config.demoMode : process.env["DEMO_MODE"] === "true";
  const demoToken = config ? config.demoToken : process.env["DEMO_TOKEN"];
  const chainId = await client.getChainId();
  add("rpc chain id", chainId === d.chainId, `${chainId} (deployments ${d.chainId})`);
  const treasury = { address: d.treasury, abi: overflowTreasuryAbi } as const;
  const read = <T,>(functionName: string, fnArgs: readonly unknown[] = []) =>
    client.readContract({ ...treasury, functionName, args: fnArgs } as Parameters<typeof client.readContract>[0]) as Promise<T>;
  const usdcOf = (a: Address) => client.readContract({ address: d.token, abi: erc20Abi, functionName: "balanceOf", args: [a] });

  // --- orchestrator (AGENT_ROOT_KEY) vs root node 1 -------------------------------------------------------------
  const keys = resolveAgentKeys();
  const node1 = await read<{ key: Address; cap: bigint; spent: bigint; maxPerCall: bigint; expiry: bigint; paused: boolean; restricted: boolean }>("getNode", [1n]);
  if (!keys.ok) {
    add("agent keys", false, keys.reason);
    // Still answer "is AGENT_ROOT_KEY node 1's key?" from whatever the slot holds: a 64-hex key (derive), or an
    // address (compare only; the runner cannot sign with an address).
    const slot = (process.env["AGENT_ROOT_KEY"] ?? "").trim();
    const rootAddr = /^0x[0-9a-fA-F]{64}$/.test(slot) ? privateKeyToAccount(slot as Hex).address : /^0x[0-9a-fA-F]{40}$/.test(slot) ? getAddress(slot) : null;
    if (rootAddr) {
      const nodeOfRoot = await read<bigint>("nodeOfKey", [rootAddr]);
      add("AGENT_ROOT_KEY is node 1's key", getAddress(node1.key) === rootAddr, `AGENT_ROOT_KEY ${slot.length === 42 ? "(address form: cannot sign)" : "(64-hex key)"} -> ${rootAddr}; getNode(1).key ${node1.key}; nodeOfKey ${nodeOfRoot}`);
    } else add("AGENT_ROOT_KEY is node 1's key", false, `AGENT_ROOT_KEY is ${slot ? "neither a key nor an address" : "unset"}; node 1 key ${node1.key}`);
  } else {
    const root = keys.keys.root.address;
    const nodeOfRoot = await read<bigint>("nodeOfKey", [root]);
    add("AGENT_ROOT_KEY is node 1's key", getAddress(node1.key) === getAddress(root), `orchestrator ${root} (${keys.keys.rootSource}); getNode(1).key ${node1.key}; nodeOfKey ${nodeOfRoot}`);
    add("node 1 live", !node1.paused && BigInt(Math.floor(Date.now() / 1000)) < node1.expiry, `paused ${node1.paused}, expiry ${new Date(Number(node1.expiry) * 1000).toISOString()}`);
    const remaining = await read<bigint>("remaining", [1n]);
    add("node 1 remaining >= mission budget", remaining >= budget, `remaining ${formatUsdc(remaining)} USDC, budget ${formatUsdc(budget)} USDC, maxPerCall ${formatUsdc(node1.maxPerCall)} USDC`);
    for (const role of ROLES) {
      const addr = keys.keys.children[role].address;
      const id = await read<bigint>("nodeOfKey", [addr]);
      if (id === 0n) add(`AGENT_KEYS ${role} fresh`, true, `${addr} owns no node yet`);
      else {
        const n = await read<{ paused: boolean; expiry: bigint }>("getNode", [id]);
        const live = !n.paused && BigInt(Math.floor(Date.now() / 1000)) < n.expiry;
        add(`AGENT_KEYS ${role} node ${id}`, live ? "warn" : false, live ? `${addr} already owns live node ${id}; the runner reuses it` : `${addr} owns paused/expired node ${id}: use a fresh key (KeyInUse)`);
      }
    }
  }

  // --- payees / attacker ---------------------------------------------------------------------------------------
  const sellers = resolveSellerConfig();
  for (const [name, payee] of Object.entries(sellers.payees) as [string, Address][]) {
    const allowed = await read<boolean>("allowlist", [payee]);
    add(`allowlist[${name} payee]`, allowed ? true : requireAllow ? false : "warn", `${payee} (${sellers.payeeSource}) allowed=${allowed}${allowed ? "" : " -> pnpm --filter @overflow/scripts allow-payee " + payee}`);
  }
  if (sellers.attacker) {
    const allowed = await read<boolean>("allowlist", [sellers.attacker]);
    add("attacker NOT allowlisted", !allowed, `SIMULATED attacker ${sellers.attacker} allowed=${allowed}`);
  } else add("ATTACKER_ADDRESS set", false, "unset: /premium-intel answers 503 and the refusal beat cannot happen");

  // --- treasury funds ------------------------------------------------------------------------------------------
  const [balance, floor, reservedTotal] = await Promise.all([usdcOf(d.treasury), read<bigint>("floor"), read<bigint>("reservedTotal").catch(() => 0n)]);
  const need = floor + reservedTotal + BigInt(SEARCH_PRICE_ATOMIC);
  add("treasury USDC covers floor + search price", balance >= need, `balance ${formatUsdc(balance)} USDC, floor ${formatUsdc(floor)}, reserved ${formatUsdc(reservedTotal)}, search ${formatUsdc(SEARCH_PRICE_ATOMIC)}`);
  add("treasury USDC covers the cheapest recourse listing", balance >= floor + reservedTotal + CHEAPEST_RECOURSE_PRICE, `recourse: cheapest listing ${formatUsdc(CHEAPEST_RECOURSE_PRICE)} USDC; balance ${formatUsdc(balance)} USDC`);

  // --- SIMULATED Recourse sellers: factory wiring, seller keys (gas ETH + bond USDC only) --------------------------
  if (!d.escrowFactory) add("escrowFactory in deployments", false, "null: redeploy with the factory (pnpm contracts:deploy); Recourse sellers stay idle");
  else {
    const code = await client.getCode({ address: d.escrowFactory });
    const onTreasury = await read<Address>("escrowFactory");
    add("escrowFactory has code", !!code && code !== "0x", `${d.escrowFactory} (${explorerUrl("address", d.escrowFactory)})`);
    add("treasury.escrowFactory() matches deployments", getAddress(onTreasury) === getAddress(d.escrowFactory), `treasury says ${onTreasury}`);
  }
  const recourse = resolveRecourseConfig();
  if (!recourse.ok) add("SELLER_KEYS (recourse sellers)", false, recourse.reason);
  else {
    const cfg = recourse.config;
    add("SELLER_KEYS (recourse sellers)", cfg.sellers.size >= 1, `${cfg.sellers.size} seller key(s): ${[...cfg.sellers.values()].map((s) => `${s.sellerId}=${cfg.behaviors.get(s.sellerId) ?? "honest"}`).join(", ")}`);
    const bond = (CHEAPEST_RECOURSE_PRICE * BigInt(cfg.bondBps)) / 10000n;
    const seen = new Set<string>();
    for (const s of cfg.sellers.values()) {
      const addr = getAddress(s.account.address);
      if (seen.has(addr)) continue;
      seen.add(addr);
      const [eth, usdc] = await Promise.all([client.getBalance({ address: addr }), usdcOf(addr)]);
      add(`seller ${addr.slice(0, 10)} gas ETH`, eth === 0n ? false : eth < MIN_SELLER_GAS_WEI ? "warn" : true, `${eth} wei${eth < MIN_SELLER_GAS_WEI ? " (< 0.0005 ETH: pnpm --filter @overflow/scripts dev-fund-gas --to " + addr + ")" : ""}`);
      add(`seller ${addr.slice(0, 10)} bond USDC`, usdc >= bond ? true : "warn", `${formatUsdc(usdc)} USDC, cheapest bond ${formatUsdc(bond)} USDC (${cfg.bondBps} bps of ${formatUsdc(CHEAPEST_RECOURSE_PRICE)})${usdc >= bond ? "" : " -> pnpm dev:fund " + formatUsdc(bond) + " --to " + addr}`);
    }
  }

  // --- relayer (gas) and owner (setAllow) ----------------------------------------------------------------------
  try {
    if (!config) throw new Error("relayer signer unresolved: see the service config row");
    const relayer = resolveSigner({ ...config.relayer, label: "RELAYER" });
    const eth = await client.getBalance({ address: relayer.account.address });
    add("relayer has gas ETH", eth > 0n, `${relayer.account.address} (${relayer.source}) ${eth} wei`);
  } catch (e) {
    add("relayer signer", false, e instanceof Error ? e.message : String(e));
  }
  const owner = await read<Address>("owner");
  try {
    const dep = resolveSigner({ keyOrAddress: process.env["DEPLOYER_PRIVATE_KEY"], account: process.env["DEPLOYER_ACCOUNT"] ?? "overflow-deployer", passwordFile: process.env["DEPLOYER_PASSWORD_FILE"], label: "DEPLOYER" });
    const [eth, usdc] = await Promise.all([client.getBalance({ address: dep.account.address }), usdcOf(dep.account.address)]);
    add("owner signer available for setAllow", getAddress(dep.account.address) === getAddress(owner), `${dep.account.address} (${dep.source}); owner() ${owner}; ${eth} wei, ${formatUsdc(usdc)} USDC`);
  } catch (e) {
    add("owner signer available for setAllow", requireAllow ? "warn" : false, `owner() ${owner}; ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- env presence by name only -------------------------------------------------------------------------------
  for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_MODEL", "SELLER_URL", "OVERFLOW_DEPLOYMENTS_PATH"]) add(`env ${name}`, !!process.env[name]?.trim(), process.env[name]?.trim() ? "set" : "unset");
  add("env DEMO_MODE=true + DEMO_TOKEN", demoMode && !!demoToken ? true : "warn", demoMode ? "set: refused settle lands on chain" : "unset: the PayeeNotAllowed refusal is simulation-only (no revert tx)");

  console.log(`preflight: treasury ${d.treasury} (${explorerUrl("address", d.treasury)}) head block ${await client.getBlockNumber()}`);
  console.table(rows);
  const failed = rows.filter((r) => r.status === "FAIL");
  console.log(failed.length ? `RESULT: ${failed.length} FAIL` : "RESULT: all required checks PASS");
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`[preflight] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
