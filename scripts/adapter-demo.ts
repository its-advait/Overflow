/**
 * pnpm demo:adapters — one real purchase through each PaymentAdapter on Base Sepolia.
 *
 *   overflow-facilitator: a SIMULATED x402 seller (local, labeled) quotes DEMO_PAYEE_ADDRESS; the adapter signs
 *                         with the agent root key and POSTs to our service's /settle.
 *   coinbase-facilitator: /reserve through our service, then the standard x402 payload to the SIMULATED seller,
 *                         whose middleware verifies and settles through COINBASE_FACILITATOR_URL
 *                         (default https://x402.org/facilitator). If that facilitator rejects a contract payer,
 *                         the run is marked BLOCKED with the exact error.
 *
 *   pnpm demo:adapters --probe-coinbase   only asks the Coinbase facilitator /verify about a treasury-as-payer
 *                                         authorization (read-only; nothing can move). Signs with the agent key if
 *                                         configured, else with the public throwaway test key.
 *
 * Needs the service running (SERVICE_URL), AGENT_ROOT_ACCOUNT + AGENT_ROOT_PASSWORD_FILE (or AGENT_ROOT_KEY),
 * DEMO_PAYEE_ADDRESS allowlisted on the treasury, and treasury USDC. Writes docs/demo-adapters.md. Never prints a key.
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { explorerUrl, USDC, type PurchaseOrder } from "@overflow/schemas";
import {
  authorizationDigest,
  b64decode,
  b64encode,
  CoinbaseFacilitatorAdapter,
  MemoryPurchaseStore,
  OverflowFacilitatorAdapter,
  randomNonce,
  signAuthorization,
  type Authorization,
  type PaymentRequirements,
  type TypedDataSigner,
} from "@overflow/payment-client";
import { resolveSigner } from "@overflow/payment-client/keystore";
import { loadEnv, repoRoot, requireEnv } from "./lib/env";

loadEnv();
const probeOnly = process.argv.includes("--probe-coinbase");
const service = (process.env["SERVICE_URL"] ?? "http://localhost:4000").replace(/\/$/, "");
const coinbase = (process.env["COINBASE_FACILITATOR_URL"] ?? "https://x402.org/facilitator").replace(/\/$/, "");
const amount = process.env["DEMO_AMOUNT"] ?? "10000";
const rpc = requireEnv("BASE_SEPOLIA_RPC_URL");
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });

function agentSigner(): { signer: TypedDataSigner; source: string } {
  const slot = process.env["AGENT_ROOT_KEY"];
  const account = process.env["AGENT_ROOT_ACCOUNT"];
  const pw = process.env["AGENT_ROOT_PASSWORD_FILE"];
  if (/^0x[0-9a-fA-F]{64}$/.test(slot ?? "") || (account && pw)) {
    const r = resolveSigner({ keyOrAddress: slot, account, passwordFile: pw, label: "AGENT_ROOT" });
    return { signer: r.account, source: r.source };
  }
  if (probeOnly) {
    return { signer: privateKeyToAccount(`0x${"a11ce".padStart(64, "0")}`), source: "public throwaway test key (probe only)" };
  }
  console.error("set AGENT_ROOT_ACCOUNT + AGENT_ROOT_PASSWORD_FILE (keystore) or a 64-hex AGENT_ROOT_KEY");
  process.exit(2);
}

type Json = Record<string, unknown>;
const link = (h: unknown) => (typeof h === "string" && /^0x[0-9a-f]{64}$/i.test(h) ? `[${h.slice(0, 10)}…](${explorerUrl("tx", h)})` : "—");

async function probeCoinbase(treasury: `0x${string}`, signer: TypedDataSigner, payTo: `0x${string}`) {
  const now = Math.floor(Date.now() / 1000);
  const authorization: Authorization = { from: treasury, to: payTo, value: amount, validAfter: String(now - 60), validBefore: String(now + 300), nonce: randomNonce() };
  const signature = await signAuthorization(signer, authorization);
  const requirements = { scheme: "exact", network: "eip155:84532", asset: USDC.address, payTo, amount, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" }, resource: { url: "https://overflow.invalid/r/probe" } };
  const body = { x402Version: 2, paymentPayload: { x402Version: 2, scheme: "exact", network: "eip155:84532", accepted: requirements, payload: { authorization, signature } }, paymentRequirements: requirements };
  const res = await fetch(`${coinbase}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Json;
  return { status: res.status, json, digest: authorizationDigest(authorization), signer: signer.address };
}

/** SIMULATED x402 seller: 402 quote, then (coinbase mode) verify + settle through the Coinbase facilitator. */
function startSimulatedSeller(payTo: `0x${string}`, port: number, mode: "quote-only" | "coinbase") {
  const server = createServer(async (req, res) => {
    const quote = { scheme: "exact", network: "eip155:84532", asset: USDC.address, payTo, amount, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } };
    const sig = req.headers["payment-signature"];
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (!sig || mode === "quote-only") {
      return send(402, { x402Version: 2, error: "payment required (SIMULATED seller)", resource: { url: `http://localhost:${port}${req.url}` }, accepts: [quote] });
    }
    const payload = b64decode<Json>(String(sig));
    const body = JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: { ...quote, resource: { url: `http://localhost:${port}${req.url}` } } });
    const verify = (await (await fetch(`${coinbase}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body })).json()) as Json;
    if (verify["isValid"] !== true) return send(402, { x402Version: 2, error: String(verify["invalidReason"] ?? "verify failed"), facilitator: coinbase, accepts: [quote] });
    const settle = (await (await fetch(`${coinbase}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body })).json()) as Json;
    if (settle["success"] !== true) return send(402, { x402Version: 2, error: String(settle["errorReason"] ?? "settle failed"), accepts: [quote] });
    send(200, { data: "SIMULATED resource bytes" }, { "payment-response": b64encode({ success: true, transaction: settle["transaction"], network: "eip155:84532", payer: settle["payer"] }) });
  });
  return new Promise<typeof server>((r) => server.listen(port, () => r(server)));
}

const rows: string[] = [];
const { signer, source } = agentSigner();
const payee = (process.env["DEMO_PAYEE_ADDRESS"] ?? "0x1111111111111111111111111111111111111111") as `0x${string}`;
const health = await fetch(`${service}/health`).then((r) => r.json() as Promise<Json>).catch(() => undefined);
const treasury = (health?.["treasury"] as `0x${string}` | undefined) ?? (process.env["TREASURY_ADDRESS"] as `0x${string}` | undefined);
if (!treasury) {
  console.error(`service at ${service} is not reachable and TREASURY_ADDRESS is unset`);
  process.exit(2);
}
console.log(`treasury ${treasury}, agent signer ${signer.address} (${source}), Coinbase facilitator ${coinbase}`);

if (probeOnly) {
  const p = await probeCoinbase(treasury, signer, payee);
  console.log(`probe: HTTP ${p.status} ${JSON.stringify(p.json)}`);
  rows.push(`| P3.4 probe: Coinbase facilitator /verify with payer = treasury (ERC-1271 only) | \`POST ${coinbase}/verify\` | HTTP ${p.status}: ${JSON.stringify(p.json)} | — (read-only) |`);
} else {
  if (!health?.["ok"]) throw new Error("service not healthy");
  const chain = {
    authorizationState: async (authorizer: `0x${string}`, nonce: `0x${string}`) =>
      (await pub.readContract({ address: USDC.address, abi: [{ type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "bool" }] }], functionName: "authorizationState", args: [authorizer, nonce] })) as boolean,
    getTransactionReceipt: async (hash: `0x${string}`) => {
      const r = await pub.getTransactionReceipt({ hash }).catch(() => null);
      return r ? { status: r.status, blockNumber: r.blockNumber } : null;
    },
  };
  const order = (id: string, path: PurchaseOrder["paymentPath"]): PurchaseOrder => ({
    id,
    orderIdBytes32: `0x${id.padEnd(64, "0").slice(0, 64)}` as `0x${string}`,
    missionId: "demo-mission",
    resourceId: "demo-resource",
    buyerTreasury: treasury,
    sellerAddress: payee,
    escrowAddress: payee, // direct allowlisted payee stands in for an escrow in this demo (labeled SIMULATED seller)
    chainId: 84532,
    tokenAddress: USDC.address,
    amountAtomic: amount,
    payingNodeId: Number(process.env["DEMO_NODE_ID"] ?? 1),
    participatingAgentIds: ["root"],
    allocations: [],
    resourceManifestHash: `0x${"00".repeat(32)}`,
    termsHash: `0x${"00".repeat(32)}`,
    paymentPath: path,
    txHashes: [],
    createdAt: new Date().toISOString(),
    authorizationExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    status: "PROPOSED",
  });
  const store = new MemoryPurchaseStore([order("overflow-1", "overflow-facilitator"), order("coinbase-1", "coinbase-facilitator")]);
  const deps = { store, signerForNode: async () => signer, chain, fetch, serviceUrl: service, requestTimeoutMs: 120_000 };

  const seller1 = await startSimulatedSeller(payee, 4101, "quote-only");
  const ov = new OverflowFacilitatorAdapter(deps);
  const q1: PaymentRequirements = await ov.getPaymentRequirements("http://localhost:4101/r/overflow");
  await ov.preparePayment("overflow-1", q1);
  const s1 = await ov.submitPayment("overflow-1");
  const r1 = await ov.reconcilePayment("overflow-1");
  console.log("overflow-facilitator:", JSON.stringify(s1), JSON.stringify(r1));
  rows.push(`| overflow-facilitator: SIMULATED seller quote -> preparePayment -> POST /settle | \`${s1.status}\` | ${s1.reason ?? "settled"}; reconcile ${r1.status} | ${link(s1.txHash)} |`);
  seller1.close();

  const seller2 = await startSimulatedSeller(payee, 4102, "coinbase");
  const cb = new CoinbaseFacilitatorAdapter(deps);
  const q2 = await cb.getPaymentRequirements("http://localhost:4102/r/coinbase");
  await cb.preparePayment("coinbase-1", q2);
  const s2 = await cb.submitPayment("coinbase-1");
  const r2 = await cb.reconcilePayment("coinbase-1");
  console.log("coinbase-facilitator:", JSON.stringify(s2), JSON.stringify(r2));
  const blocked = s2.status !== "ESCROW_FUNDED" ? "BLOCKED: " : "";
  rows.push(`| coinbase-facilitator: POST /reserve -> x402 payload to the SIMULATED seller -> ${coinbase} | \`${s2.status}\` | ${blocked}${s2.reason ?? "settled by the Coinbase facilitator"}; reconcile ${r2.status}: ${r2.reason ?? ""} | ${link(s2.txHash)} |`);
  seller2.close();
}

const md = [
  "# Payment adapters on Base Sepolia",
  "",
  `Run by \`pnpm demo:adapters${probeOnly ? " --probe-coinbase" : ""}\` on ${new Date().toISOString()} against treasury [${treasury}](${explorerUrl("address", treasury)}); agent signer ${signer.address} (${source}). Sellers are SIMULATED local x402 servers.`,
  "",
  "| Step | Result | Detail | Transaction |",
  "|---|---|---|---|",
  ...rows,
  "",
];
const out = resolve(repoRoot(), "docs", "demo-adapters.md");
writeFileSync(out, md.join("\n"));
console.log(`wrote ${out}`);
