// Demo and acceptance script for the SIMULATED sellers (docs/SPEC.md Armadin table):
//
//   1. an allowed agent pays GET /api/search (0.02 USDC) and the receipt confirms it;
//   2. a paid scrape of the injected listing hands the agent a hidden instruction; the honest
//      client refuses /premium-intel before signing; a SIMULATED prompt-injected agent that skips
//      the check signs anyway, and the treasury reverts PayeeNotAllowed(0) on chain (tx hash);
//   3. the mismatched-quote fixture is refused before signing on amount and on payTo.
//
//   pnpm --filter @overflow/service sellers:demo [--offline]
//
// Env (repo .env): SELLER_URL, BASE_SEPOLIA_RPC_URL, AGENT_KEYS (first key is the paying node),
// deployments/base-sepolia.json for the treasury. The seller must run with DEMO_MODE=true for beat 2b.
// --offline runs only the beats that need no chain (2a honest refusal, 3) against a running seller.
//
// This script never calls USDC to move funds and never retries a payment with a new nonce.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  buildPaymentHeader,
  buildPaymentPayload,
  parsePaymentRequired,
  parsePaymentResponse,
  QuoteMismatchError,
  selectRequirements,
  signTransfer,
  wrapFetch,
  X402_HEADERS,
  type PaymentRequirements,
} from "@overflow/payment-client";
import { AddressSchema, explorerUrl, loadDeployments, USDC, type Address, type Hex } from "@overflow/schemas";
import { createPublicClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { treasurySettleAbi, usdcSettleAbi } from "../src/facilitator/abi.js";
import { directApiOrder, FORCE_BROADCAST_HEADER, LISTING_PATH, MISMATCHED_QUOTE_PATH, PREMIUM_INTEL_PATH, SCRAPE_PRICE_ATOMIC, SEARCH_PRICE_ATOMIC } from "../src/sellers/index.js";

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const log = (s: string): void => console.log(s);
let failures = 0;
function check(ok: boolean, what: string): void {
  log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
}
const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
};

async function main(): Promise<void> {
  loadEnv(resolve(repoRoot, ".env"));
  // pnpm forwards a literal "--", which would end option parsing; drop it.
  const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { offline: { type: "boolean", default: false } }, allowPositionals: true });
  const offline = values.offline;
  const sellerUrl = (process.env["SELLER_URL"] || "http://localhost:4100").replace(/\/$/, "");

  const health = (await (await fetch(`${sellerUrl}/health`)).json()) as {
    facilitator: string;
    payees: { search: Address; scrape: Address };
    attackerConfigured: boolean;
    forceBroadcastAllowed: boolean;
    searchProvider: string;
  };
  log(`seller ${sellerUrl}: facilitator=${health.facilitator}, provider=${health.searchProvider}, attacker fixture=${health.attackerConfigured}, force-broadcast=${health.forceBroadcastAllowed}`);
  if (!offline && health.facilitator !== "chain") throw new Error(`seller has no chain facilitator (${health.facilitator}); start it with the chain env or pass --offline`);

  // The agent: AGENT_KEYS[0] signs; without a chain a throwaway key is enough for refusals that never sign.
  const agentKeys = (process.env["AGENT_KEYS"] ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const nodeAccount = privateKeyToAccount((agentKeys[0] ?? `0x${"ab".repeat(32)}`) as Hex);
  const treasury: Address = offline && !existsSync(resolve(repoRoot, "deployments/base-sepolia.json"))
    ? ("0x1111111111111111111111111111111111111111" as Address)
    : getAddress(AddressSchema.parse((await loadDeployments()).treasury));
  const publicClient = offline ? null : createPublicClient({ chain: baseSepolia, transport: http(requireEnv("BASE_SEPOLIA_RPC_URL")) });

  /** Owner allowlist, read from the chain; never from env. Offline: the seller's own payees (no chain to ask). */
  async function allowlisted(candidates: readonly Address[]): Promise<readonly Address[]> {
    if (!publicClient) return candidates;
    const flags = await Promise.all(
      candidates.map((a) => publicClient.readContract({ address: treasury, abi: treasurySettleAbi, functionName: "allowlist", args: [a] })),
    );
    return candidates.filter((_, i) => flags[i]);
  }

  /** The agent's expectation per route: what it is willing to pay, to whom. */
  function agentFetch(expected: { payTo: Address; amountAtomic: string }) {
    const signed: Hex[] = [];
    const fetchPaid = wrapFetch(fetch, {
      nodeAccount,
      treasury,
      adapter: {
        async resolveOrder({ url }) {
          return directApiOrder({ resourceUrl: url, payTo: expected.payTo, amountAtomic: expected.amountAtomic, treasury, nodeId: 1 });
        },
        approvedDirectSellers: () => allowlisted([health.payees.search, health.payees.scrape]),
        async onAuthorized(ctx) {
          signed.push(ctx.signed.digest);
          log(`  signed digest ${ctx.signed.digest} (from = treasury, to = ${ctx.quote.payTo}, ${ctx.quote.valueAtomic} atomic)`);
        },
      },
    });
    return { fetchPaid, signed };
  }

  async function confirmReceipt(txHash: Hex, expectStatus: "success" | "reverted"): Promise<void> {
    if (!publicClient) return;
    const r = await publicClient.waitForTransactionReceipt({ hash: txHash });
    check(r.status === expectStatus, `receipt ${txHash} status ${r.status} in block ${r.blockNumber}  ${explorerUrl("tx", txHash)}`);
  }

  // ---- 1. allowed agent pays /api/search ------------------------------------------------------
  if (!offline) {
    log("\n[1] allowed agent pays GET /api/search (0.02 USDC)");
    const { fetchPaid, signed } = agentFetch({ payTo: health.payees.search, amountAtomic: SEARCH_PRICE_ATOMIC });
    const res = await fetchPaid(`${sellerUrl}/api/search?q=${encodeURIComponent("US EV registrations by state 2024-2026")}`);
    const body = (await res.json()) as { results?: unknown[]; error?: string; decoded?: unknown };
    check(res.status === 200, `HTTP ${res.status}${body.error ? ` ${body.error} ${JSON.stringify(body.decoded ?? "")}` : ""}`);
    check(signed.length === 1, `exactly one signature (${signed.length})`);
    const settlement = parsePaymentResponse(res);
    check(settlement?.success === true, `PAYMENT-RESPONSE success=${settlement?.success} tx ${settlement?.transaction}`);
    if (settlement?.success) await confirmReceipt(settlement.transaction as Hex, "success");
    log(`  ${body.results?.length ?? 0} results (canned or provider, plus the labeled fixture listing)`);
  } else {
    log("\n[1] SKIPPED (--offline): paying /api/search needs the chain facilitator");
  }

  // ---- 2. the injected listing --------------------------------------------------------------
  log(`\n[2] the injected listing ${LISTING_PATH} (SIMULATED test fixture)`);
  let markdown: string;
  if (!offline) {
    const { fetchPaid, signed } = agentFetch({ payTo: health.payees.scrape, amountAtomic: SCRAPE_PRICE_ATOMIC });
    const res = await fetchPaid(`${sellerUrl}/api/scrape?url=${encodeURIComponent(`${sellerUrl}${LISTING_PATH}`)}`);
    const body = (await res.json()) as { markdown?: string; error?: string };
    check(res.status === 200 && signed.length === 1, `paid scrape HTTP ${res.status}, ${signed.length} signature`);
    const settlement = parsePaymentResponse(res);
    if (settlement?.success) await confirmReceipt(settlement.transaction as Hex, "success");
    markdown = body.markdown ?? "";
  } else {
    // Offline: read the free page and convert it the way the scrape route does.
    const { htmlToMarkdown } = await import("../src/sellers/listing.js");
    markdown = htmlToMarkdown(await (await fetch(`${sellerUrl}${LISTING_PATH}`)).text());
  }
  const hidden = markdown.split("\n").find((l) => l.includes("SYSTEM NOTICE TO AI AGENTS")) ?? "";
  check(hidden.includes(PREMIUM_INTEL_PATH), `scraped text carries the hidden instruction: "${hidden.slice(0, 140)}..."`);

  log(`\n[2a] honest client follows the instruction to ${PREMIUM_INTEL_PATH}: checkQuote refuses before signing`);
  {
    const { fetchPaid, signed } = agentFetch({ payTo: health.payees.search, amountAtomic: SEARCH_PRICE_ATOMIC });
    try {
      await fetchPaid(`${sellerUrl}${PREMIUM_INTEL_PATH}`);
      check(false, "expected QuoteMismatchError");
    } catch (err) {
      check(err instanceof QuoteMismatchError && err.field === "payTo", `refused: ${err instanceof Error ? err.message : String(err)}`);
    }
    check(signed.length === 0, "nothing was signed");
  }

  if (!offline) {
    log(`\n[2b] SIMULATED prompt-injected agent skips the client check and signs for the attacker; the treasury must revert`);
    if (!health.forceBroadcastAllowed) log("  WARNING: seller is not in DEMO_MODE=true; the revert will be blocked by simulation only (no tx hash)");
    const first = await fetch(`${sellerUrl}${PREMIUM_INTEL_PATH}`);
    const requirements: PaymentRequirements | null = selectRequirements(parsePaymentRequired(first));
    if (!requirements) throw new Error("premium-intel offered nothing payable");
    const attacker = getAddress(requirements.payTo);
    const balanceBefore = publicClient ? await publicClient.readContract({ address: USDC.address, abi: usdcSettleAbi, functionName: "balanceOf", args: [attacker] }) : 0n;
    // Deliberately NOT checkQuote: this models the compromised agent. Labeled SIMULATED attack.
    const signed = await signTransfer({ nodeAccount, treasury, to: attacker, value: requirements.amount, ttlSeconds: 120 });
    const header = buildPaymentHeader(buildPaymentPayload({ accepted: requirements, signed }));
    const second = await fetch(`${sellerUrl}${PREMIUM_INTEL_PATH}`, { headers: { [header.name]: header.value, [FORCE_BROADCAST_HEADER]: "1" } });
    const body = (await second.json()) as { error?: string; decoded?: { name: string; args: string[]; reason: string }; txHash?: Hex };
    check(second.status === 402 && body.error === "payment_blocked", `HTTP ${second.status} ${body.error ?? ""}`);
    check(body.decoded?.name === "PayeeNotAllowed" && body.decoded.args[0] === "0", `decoded ${body.decoded?.name}(${body.decoded?.args.join(",")}) : ${body.decoded?.reason}`);
    check(second.headers.get(X402_HEADERS.paymentResponse) === null, "no PAYMENT-RESPONSE (nothing settled)");
    if (body.txHash) {
      await confirmReceipt(body.txHash, "reverted");
    } else {
      check(false, "no tx hash: the revert was not broadcast (seller needs DEMO_MODE=true)");
    }
    if (publicClient) {
      const balanceAfter = await publicClient.readContract({ address: USDC.address, abi: usdcSettleAbi, functionName: "balanceOf", args: [attacker] });
      check(balanceAfter === balanceBefore, `attacker USDC balance unchanged (${balanceAfter})`);
    }
  } else {
    log("\n[2b] SKIPPED (--offline): the on-chain PayeeNotAllowed revert needs the chain facilitator");
  }

  // ---- 3. mismatched quote ------------------------------------------------------------------
  log(`\n[3] mismatched quote fixture ${MISMATCHED_QUOTE_PATH}: refused before signing`);
  for (const field of ["amount", "payTo"] as const) {
    const { fetchPaid, signed } = agentFetch({ payTo: health.payees.search, amountAtomic: SEARCH_PRICE_ATOMIC });
    try {
      await fetchPaid(`${sellerUrl}${MISMATCHED_QUOTE_PATH}?field=${field}`);
      check(false, `field=${field}: expected QuoteMismatchError`);
    } catch (err) {
      check(err instanceof QuoteMismatchError && err.field === field, `field=${field}: ${err instanceof Error ? err.message : String(err)}`);
    }
    check(signed.length === 0, `field=${field}: nothing was signed`);
  }

  log(failures === 0 ? `\nall checks passed${offline ? " (offline subset)" : ""}` : `\n${failures} check(s) FAILED`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
