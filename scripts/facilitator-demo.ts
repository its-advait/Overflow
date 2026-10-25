/**
 * pnpm demo:facilitator — Base Sepolia proof for the facilitator (docs/SPEC.md "Proof it works"):
 *   1. an allowed agent pays the demo payee through POST /settle            -> Paid, tx hash
 *   2. the same agent signs a payment to the SIMULATED attacker:
 *        POST /verify decodes PayeeNotAllowed; POST /settle with forceBroadcast lands the revert onchain -> tx hash
 *   3. the attacker payment sent straight to USDC via POST /demo/bypass    -> rejected by USDC, tx hash
 *   4. step 1 replayed                                                      -> 409 with the original result
 * Writes docs/demo-facilitator.md from the real responses. Needs the service running with DEMO_MODE=true.
 * Signs as the agent's root node key: AGENT_ROOT_ACCOUNT + AGENT_ROOT_PASSWORD_FILE (Foundry keystore, decrypted in
 * memory) or a 64-hex AGENT_ROOT_KEY. Also reads ATTACKER_ADDRESS, DEMO_PAYEE_ADDRESS, DEMO_TOKEN, SERVICE_URL from
 * .env. Never prints a key.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { explorerUrl } from "@overflow/schemas/chain";
import { randomNonce, signAuthorization, type Authorization } from "@overflow/payment-client";
import { resolveSigner } from "@overflow/payment-client/keystore";
import { loadEnv, repoRoot, requireEnv } from "./lib/env";

loadEnv();
const base = (process.env["SERVICE_URL"] ?? "http://localhost:4000").replace(/\/$/, "");
const agentSigner = resolveSigner({
  keyOrAddress: process.env["AGENT_ROOT_KEY"],
  account: process.env["AGENT_ROOT_ACCOUNT"],
  passwordFile: process.env["AGENT_ROOT_PASSWORD_FILE"],
  label: "AGENT_ROOT",
});
const agent = agentSigner.account;
const attacker = requireEnv("ATTACKER_ADDRESS") as `0x${string}`;
const payee = requireEnv("DEMO_PAYEE_ADDRESS") as `0x${string}`;
const demoToken = requireEnv("DEMO_TOKEN");
const amount = process.env["DEMO_AMOUNT"] ?? "10000"; // 0.01 USDC in atomic units

type Json = Record<string, unknown>;
async function call(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Json };
}

const health = (await (await fetch(`${base}/health`)).json()) as Json;
if (!health["ok"]) throw new Error(`service not healthy: ${JSON.stringify(health)}`);
if (!health["demoMode"]) throw new Error("service is not in DEMO_MODE=true; steps 2 and 3 need it");
const treasury = health["treasury"] as `0x${string}`;
console.log(`facilitator ${base}, treasury ${treasury}, relayer ${health["relayer"]}, agent ${agent.address} (${agentSigner.source})`);

async function authorize(to: `0x${string}`): Promise<{ authorization: Authorization; signature: `0x${string}` }> {
  const now = Math.floor(Date.now() / 1000);
  const authorization: Authorization = { from: treasury, to, value: amount, validAfter: String(now - 60), validBefore: String(now + 600), nonce: randomNonce() };
  return { authorization, signature: await signAuthorization(agent, authorization) };
}
const payload = (p: { authorization: Authorization; signature: `0x${string}` }) => ({ paymentPayload: { payload: p } });

const rows: Array<{ step: string; route: string; result: string; tx: string }> = [];
const link = (h: unknown) => (typeof h === "string" && h.startsWith("0x") && h.length === 66 ? `[${h.slice(0, 10)}…](${explorerUrl("tx", h as `0x${string}`)})` : "—");

// 1. allowed payment
const good = await authorize(payee);
const settle = await call("/settle", payload(good));
console.log("1. settle ->", settle.status, JSON.stringify(settle.json));
if (settle.json["success"] !== true) throw new Error("step 1 did not settle");
rows.push({ step: "1. allowed agent pays demo payee", route: "POST /settle", result: `success, node ${settle.json["nodeId"]}`, tx: link(settle.json["transaction"]) });

// 2. attacker payment: policy revert
const bad = await authorize(attacker);
const verify = await call("/verify", payload(bad));
console.log("2a. verify ->", JSON.stringify(verify.json));
const decoded = verify.json["decoded"] as Json | undefined;
if (verify.json["isValid"] !== false || decoded?.["name"] !== "PayeeNotAllowed") throw new Error("step 2 expected PayeeNotAllowed from /verify");
rows.push({ step: "2a. SIMULATED attacker as payee", route: "POST /verify", result: `${decoded["name"]}(${(decoded["args"] as string[]).join(",")}): ${decoded["reason"]}`, tx: "— (eth_call)" });
const forced = await call("/settle", { ...payload(bad), forceBroadcast: true }, { "x-demo-token": demoToken });
console.log("2b. settle forceBroadcast ->", forced.status, JSON.stringify(forced.json));
if (forced.json["success"] !== false || typeof forced.json["transaction"] !== "string") throw new Error("step 2b expected a reverted transaction hash");
rows.push({ step: "2b. same payment broadcast (DEMO forceBroadcast)", route: "POST /settle", result: `reverted onchain: ${(forced.json["decoded"] as Json)["name"]}`, tx: link(forced.json["transaction"]) });

// 3. bypass straight to USDC
const bypass = await call("/demo/bypass", bad, { "x-demo-token": demoToken });
console.log("3. bypass ->", bypass.status, JSON.stringify(bypass.json));
if (bypass.json["rejected"] !== true) throw new Error("step 3 expected USDC to reject the bypass");
rows.push({ step: "3. same signature sent straight to USDC (SIMULATED attacker)", route: "POST /demo/bypass", result: `rejected: ${bypass.json["reason"]}`, tx: link(bypass.json["transaction"]) });

// 4. replay
const replay = await call("/settle", payload(good));
console.log("4. replay ->", replay.status);
if (replay.status !== 409) throw new Error("step 4 expected 409");
rows.push({ step: "4. step 1 replayed", route: "POST /settle", result: "409 AlreadySubmitted with the original result", tx: link((replay.json["original"] as Json)["txHash"]) });

const md = [
  "# Facilitator demo on Base Sepolia",
  "",
  `Run by \`pnpm demo:facilitator\` on ${new Date().toISOString()} against treasury [${treasury}](${explorerUrl("address", treasury)}), agent node key ${agent.address}, relayer ${health["relayer"]}. Amount ${amount} atomic USDC per payment. The attacker and payee are SIMULATED test addresses.`,
  "",
  "| Step | Route | Result | Transaction |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.step} | \`${r.route}\` | ${r.result} | ${r.tx} |`),
  "",
];
const out = resolve(repoRoot(), "docs", "demo-facilitator.md");
writeFileSync(out, md.join("\n"));
console.log(`wrote ${out}`);
