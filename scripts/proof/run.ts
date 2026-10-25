/**
 * pnpm proof --fork | --live
 *
 * Runs docs/SPEC.md "Planted-error set with answer key" and writes docs/proof/results.{md,json}.
 *   --fork: anvil forking Base Sepolia (BASE_SEPOLIA_RPC_URL, never printed); the deployed treasury and factory, owner
 *           impersonated, every other actor a fresh fork-only key, USDC minted through Circle's real masterMinter.
 *   --live: real Base Sepolia. A balance preflight runs before each onchain case; a case whose senders lack gas or whose
 *           treasury lacks USDC is BLOCKED with the exact shortfall and nothing is sent for it.
 * Exit 1 on any FAIL or BLOCKED.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadDeployments, overflowTreasuryAbi } from "@overflow/schemas";
import { erc20Abi, formatEther, getAddress, keccak256, stringToHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnv, repoRoot } from "../lib/env.js";
import { startAnvil, redact, type Anvil } from "./anvil.js";
import { fundUsdc, makeClient, newKey, ownerWrite, setEth, type ProofContext } from "./context.js";
import { exitCodeFor, mergeRun, renderResults, summarize } from "./report.js";
import type { AnyCase, CaseResult, Mode, ResultsFile, RunRecord } from "./types.js";

import c01 from "./cases/01-attacker-payee.js";
import c02 from "./cases/02-direct-usdc.js";
import c03 from "./cases/03-search-only-scrape.js";
import c04 from "./cases/04-over-per-call.js";
import c05 from "./cases/05-over-budget-parent.js";
import c06 from "./cases/06-expired.js";
import c07 from "./cases/07-paused-root.js";
import c08 from "./cases/08-timeout-refund.js";
import c09 from "./cases/09-swapped-chunk.js";
import c10 from "./cases/10-wrong-source-key.js";
import c11 from "./cases/11-false-complaint.js";
import c12 from "./cases/12-fusion-merge.js";
import c13 from "./cases/13-fusion-wrong-region.js";
import c14 from "./cases/14-fusion-single-user.js";
import c15 from "./cases/15-oracle-missing-dates.js";
import c16 from "./cases/16-concurrent-buys.js";
import c17 from "./cases/17-rpc-timeout.js";
import c18 from "./cases/18-flagged-seller.js";
import c19 from "./cases/19-quote-mismatch.js";
import c20 from "./cases/20-ledger-planted-diff.js";

export const CASES: AnyCase[] = [c01, c02, c03, c04, c05, c06, c07, c08, c09, c10, c11, c12, c13, c14, c15, c16, c17, c18, c19, c20];

const log = (line: string): void => console.log(line);
/** SIMULATED address derived from a label; nobody holds its key. */
const simulatedAddressLabel = (label: string): Address => getAddress(`0x${keccak256(stringToHex(label)).slice(-40)}`);
/** Live preflight gas allowance per transaction (gas units); fee = units x current maxFeePerGas x 2. */
const GAS_PER_TX = 500_000n;

function addressFromSlot(slot: string | undefined): Address | null {
  const s = (slot ?? "").trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return privateKeyToAccount(s as `0x${string}`).address;
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return getAddress(s);
  return null;
}

async function main(): Promise<number> {
  const mode: Mode | null = process.argv.includes("--fork") ? "fork" : process.argv.includes("--live") ? "live" : null;
  if (!mode) {
    console.error("usage: pnpm proof --fork | --live");
    return 2;
  }
  loadEnv();
  const upstream = process.env["BASE_SEPOLIA_RPC_URL"];
  if (!upstream) {
    console.error("BASE_SEPOLIA_RPC_URL is not set (repo .env)");
    return 2;
  }
  const secrets = [upstream];
  const deployments = await loadDeployments(process.env["OVERFLOW_DEPLOYMENTS_PATH"] || undefined);
  if (!deployments.escrowFactory) throw new Error("deployments file has no escrowFactory");
  const startedAt = new Date().toISOString();
  let anvil: Anvil | undefined;
  const results: CaseResult[] = [];
  const notes: string[] = [];
  let ctx: ProofContext | undefined;
  let startBlock = 0n;
  let forkBlock: bigint | undefined;
  const actors: Record<string, string> = {};
  try {
    const rpcUrl = mode === "fork" ? (anvil = await startAnvil({ forkUrl: upstream, log })).url : upstream;
    const pub = makeClient(rpcUrl);
    startBlock = await pub.getBlockNumber();
    if (mode === "fork") forkBlock = startBlock;
    if (!deployments.owner) throw new Error("deployments file has no owner");
    const owner = getAddress(deployments.owner);
    const relayer = newKey();
    ctx = {
      mode,
      rpcUrl,
      pub,
      deployments,
      treasury: getAddress(deployments.treasury),
      factory: getAddress(deployments.escrowFactory as Address),
      usdc: getAddress(deployments.usdc),
      owner,
      relayer,
      payees: {
        search: simulatedAddressLabel("overflow.proof.simulated.search-payee"),
        scrape: simulatedAddressLabel("overflow.proof.simulated.scrape-payee"),
        attacker: simulatedAddressLabel("overflow.proof.simulated.attacker"),
      },
      txs: [],
      offsetMs: 0,
      log,
    };

    if (mode === "fork") {
      // Fork-only setup: owner impersonated, fresh relayer key, SIMULATED payees allowlisted, treasury funded.
      await pub.request({ method: "anvil_impersonateAccount" as never, params: [owner] as never });
      await setEth(ctx, owner);
      await setEth(ctx, relayer.address);
      await ownerWrite(ctx, "setAllow", [ctx.payees.search, true], "owner setAllow(SIMULATED search seller)");
      await ownerWrite(ctx, "setAllow", [ctx.payees.scrape, true], "owner setAllow(SIMULATED scrape seller)");
      await fundUsdc(ctx, ctx.treasury, 100_000_000n);
      const attackerAllowed = await pub.readContract({ address: ctx.treasury, abi: overflowTreasuryAbi, functionName: "allowlist", args: [ctx.payees.attacker] });
      if (attackerAllowed) throw new Error("SIMULATED attacker is allowlisted on the fork; refusing to run");
      notes.push(`Fork setup: owner ${owner} impersonated; fresh fork-only relayer; SIMULATED payees allowlisted by the owner; 100 USDC minted to the treasury through USDC's masterMinter (fork only). Setup txs are not listed per case.`);
      ctx.txs = [];
      Object.assign(actors, { owner: `${owner} (impersonated on the fork)`, relayer: `${relayer.address} (fresh fork-only key)`, "search payee (SIMULATED)": ctx.payees.search, "scrape payee (SIMULATED)": ctx.payees.scrape, "attacker (SIMULATED, never allowlisted)": ctx.payees.attacker });
    } else {
      notes.push("Live mode in this build: balance preflight per onchain case; nothing is sent for a BLOCKED case. Live execution of a funded case is NOT IMPLEMENTED in this build and reports FAIL.");
    }

    // Live balances (read once per case before it runs).
    const liveRelayer = addressFromSlot(process.env["RELAYER_PRIVATE_KEY"]);
    const liveOwner = owner;
    if (mode === "live") {
      Object.assign(actors, { owner: liveOwner, relayer: liveRelayer ?? "unset (RELAYER_PRIVATE_KEY)" });
    }

    // --only 8,9,10: run a subset while developing. A partial run never writes docs/proof (the published table is always a full run).
    const onlyArg = process.argv.indexOf("--only");
    const only = onlyArg >= 0 ? new Set((process.argv[onlyArg + 1] ?? "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n))) : null;
    if (only && only.size === 0) throw new Error("--only needs a comma-separated list of case numbers, e.g. --only 8,9");
    for (const c of CASES.filter((x) => !only || only.has(x.id))) {
      const t0 = Date.now();
      const base = { id: c.id, slug: c.slug, plantedError: c.plantedError, expected: c.expected, caughtBy: c.caughtBy, onchain: c.onchain };
      ctx.txs = [];
      if (mode === "live") {
        if (c.live.kind === "skip") {
          results.push({ ...base, verdict: "NOT_RUN", actual: "", reasons: [`not run live: ${c.live.reason}`], txs: [], durationMs: 0 });
          log(`[proof] ${String(c.id).padStart(2, "0")} NOT RUN (live): ${c.live.reason}`);
          continue;
        }
        if (c.live.kind === "onchain") {
          const n = c.live.needs;
          const fees = await pub.estimateFeesPerGas();
          const perTx = GAS_PER_TX * fees.maxFeePerGas * 2n;
          const reasons: string[] = [];
          const checkEth = async (role: string, a: Address | null, txs: number) => {
            if (txs === 0) return;
            if (!a) return void reasons.push(`${role}: signer not configured`);
            const have = await pub.getBalance({ address: a });
            const need = perTx * BigInt(txs);
            if (have < need) reasons.push(`${role} ${a} has ${have} wei (${formatEther(have)} ETH), needs >= ${need} wei for ${txs} tx(s) (${GAS_PER_TX} gas x ${fees.maxFeePerGas} wei maxFee x2); shortfall ${need - have} wei`);
          };
          await checkEth("relayer", liveRelayer, n.relayerTxs);
          await checkEth("owner (deployer)", liveOwner, n.ownerTxs);
          if (n.treasuryUsdc > 0n) {
            const have = (await pub.readContract({ address: ctx.usdc, abi: erc20Abi, functionName: "balanceOf", args: [ctx.treasury] })) as bigint;
            if (have < n.treasuryUsdc) reasons.push(`treasury ${ctx.treasury} holds ${have} atomic USDC, needs ${n.treasuryUsdc}; shortfall ${n.treasuryUsdc - have}`);
          }
          if (reasons.length) {
            results.push({ ...base, verdict: "BLOCKED", actual: "", reasons: [...reasons, "nothing was sent"], txs: [], durationMs: Date.now() - t0 });
            log(`[proof] ${String(c.id).padStart(2, "0")} BLOCKED: ${reasons.join("; ")}`);
            continue;
          }
          results.push({ ...base, verdict: "FAIL", actual: "NOT IMPLEMENTED: funded live execution is not implemented in this build; nothing was sent", txs: [], durationMs: Date.now() - t0 });
          log(`[proof] ${String(c.id).padStart(2, "0")} FAIL: live execution not implemented`);
          continue;
        }
      }
      try {
        const s = await c.setup(ctx);
        const o = await c.action(ctx, s);
        const r = await c.check(ctx, o);
        results.push({ ...base, verdict: r.pass ? "PASS" : "FAIL", actual: redact(r.actual, secrets), txHash: r.txHash, txs: [...ctx.txs], durationMs: Date.now() - t0 });
        log(`[proof] ${String(c.id).padStart(2, "0")} ${r.pass ? "PASS" : "FAIL"}: ${redact(r.actual, secrets)}`);
      } catch (e) {
        const msg = redact(e instanceof Error ? e.message.split("\n").slice(0, 3).join(" ") : String(e), secrets);
        results.push({ ...base, verdict: "FAIL", actual: `error: ${msg}`, txs: [...ctx.txs], durationMs: Date.now() - t0 });
        log(`[proof] ${String(c.id).padStart(2, "0")} FAIL (error): ${msg}`);
      }
    }
    const endBlock = await pub.getBlockNumber();
    const run: RunRecord = {
      mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      chain: {
        chainId: await pub.getChainId(),
        startBlock: startBlock.toString(),
        endBlock: endBlock.toString(),
        ...(forkBlock !== undefined ? { forkBlock: forkBlock.toString() } : {}),
        node: mode === "fork" ? `${anvil?.version ?? "anvil"} on 127.0.0.1 forking Base Sepolia (BASE_SEPOLIA_RPC_URL, not printed)` : "Base Sepolia via BASE_SEPOLIA_RPC_URL (not printed)",
      },
      contracts: { treasury: ctx.treasury, escrowFactory: ctx.factory, usdc: ctx.usdc, owner },
      actors,
      summary: summarize(results),
      results,
      notes,
    };
    if (only) {
      const s = run.summary;
      log(`[proof] ${mode} (--only ${[...only].join(",")}, partial run: docs/proof not written): ${s.passed}/${s.total} passed, ${s.failed} failed, ${s.blocked} blocked, ${s.notRun} not run`);
      return exitCodeFor(run);
    }
    const dir = resolve(repoRoot(), "docs", "proof");
    mkdirSync(dir, { recursive: true });
    const jsonPath = resolve(dir, "results.json");
    const prev: ResultsFile | undefined = existsSync(jsonPath) ? (JSON.parse(readFileSync(jsonPath, "utf8")) as ResultsFile) : undefined;
    const file = mergeRun(prev, run);
    writeFileSync(jsonPath, `${JSON.stringify(file, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
    writeFileSync(resolve(dir, "results.md"), renderResults(file));
    const s = run.summary;
    log(`[proof] ${mode}: ${s.passed}/${s.total} passed, ${s.failed} failed, ${s.blocked} blocked, ${s.notRun} not run -> docs/proof/results.md`);
    return exitCodeFor(run);
  } finally {
    await anvil?.stop();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    const url = process.env["BASE_SEPOLIA_RPC_URL"] ?? "";
    console.error(`[proof] fatal: ${redact(e instanceof Error ? e.message : String(e), [url])}`);
    process.exit(1);
  },
);
