/**
 * pnpm spike:coinbase — SPIKE (throwaway): does Coinbase's x402 facilitator settle a payment whose payer is our
 * treasury (a contract that answers ERC-1271 only to USDC, only for a live reservation)?
 *
 * Signs one TransferWithAuthorization per case with from = treasury using the agent root key (keystore) or, with
 * SPIKE_THROWAWAY=1, the public throwaway test key. Then:
 *   (a) with reserve:    POST <SERVICE_URL>/reserve, then GET the paid route with PAYMENT-SIGNATURE
 *   (b) without reserve: GET the paid route with PAYMENT-SIGNATURE
 *   (c) expired:         validBefore in the past, GET the paid route
 * against the spike seller (apps/service/src/sellers/spike, official @x402/hono middleware) which uses the
 * facilitator named by SPIKE_FACILITATOR (cdp | public). Every request and response is recorded verbatim in
 * docs/coinbase-feedback.md. Nothing here reads a key into logs; no transaction is sent by this script itself.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { explorerUrl, USDC } from "@overflow/schemas";
import { authorizationDigest, b64decode, b64encode, randomNonce, signAuthorization, type Authorization, type TypedDataSigner } from "@overflow/payment-client";
import { resolveSigner } from "@overflow/payment-client/keystore";
import { loadEnv, repoRoot } from "./lib/env";

loadEnv();
const seller = (process.env["SPIKE_SELLER_URL"] ?? "http://localhost:4402").replace(/\/$/, "");
const service = (process.env["SERVICE_URL"] ?? "http://localhost:4000").replace(/\/$/, "");
const facilitatorName = process.env["SPIKE_FACILITATOR"] ?? "cdp";
const treasury = (process.env["TREASURY_ADDRESS"] ?? "0xd3A74fA991CA0B5627d30EF27dC699C134848291") as `0x${string}`;

function signer(): { signer: TypedDataSigner; source: string } {
  if (process.env["SPIKE_THROWAWAY"] === "1") {
    return { signer: privateKeyToAccount(`0x${"a11ce".padStart(64, "0")}`), source: "public throwaway test key (not a treasury node key)" };
  }
  const r = resolveSigner({ keyOrAddress: process.env["AGENT_ROOT_KEY"], account: process.env["AGENT_ROOT_ACCOUNT"], passwordFile: process.env["AGENT_ROOT_PASSWORD_FILE"], label: "AGENT_ROOT" });
  return { signer: r.account, source: r.source };
}

type Json = Record<string, unknown>;
type Quote = { scheme: string; network: string; asset: string; payTo: `0x${string}`; amount: string; maxTimeoutSeconds?: number; extra?: Json };
const redact = (s: string) => s.replace(/0x[0-9a-fA-F]{130}/g, (m) => `${m.slice(0, 14)}…(signature, 65 bytes)`);

async function record(title: string, method: string, url: string, init: RequestInit, extraNote?: string): Promise<{ res: Response; text: string; md: string }> {
  const res = await fetch(url, init);
  const text = await res.text();
  const headers: string[] = [];
  res.headers.forEach((v, k) => {
    if (["payment-response", "payment-required", "content-type", "x-payment-response"].includes(k)) headers.push(`${k}: ${v.length > 300 ? v.slice(0, 300) + "…" : v}`);
  });
  const reqHeaders = Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => `${k}: ${k.toLowerCase() === "payment-signature" ? v.slice(0, 40) + "…(base64, " + v.length + " chars)" : v}`);
  const decodedPaymentResponse = res.headers.get("payment-response") ? `\nDecoded PAYMENT-RESPONSE: \`${JSON.stringify(b64decode(res.headers.get("payment-response")!))}\`` : "";
  const pr = res.headers.get("payment-required");
  let decodedRequired = "";
  if (pr && res.status === 402) {
    try {
      const d = b64decode<Json>(pr);
      decodedRequired = `\nDecoded PAYMENT-REQUIRED (402): error = \`${String(d["error"])}\`${d["extensions"] ? `, extensions = \`${JSON.stringify(d["extensions"]).slice(0, 300)}\`` : ""}`;
    } catch {
      decodedRequired = "\nPAYMENT-REQUIRED header present but not decodable";
    }
  }
  const body = init.body ? `\n\nRequest body:\n\`\`\`json\n${redact(String(init.body))}\n\`\`\`` : "";
  const md = `#### ${title}\n\n\`${method} ${url}\`${reqHeaders.length ? `\n\nRequest headers:\n\`\`\`\n${reqHeaders.join("\n")}\n\`\`\`` : ""}${body}${extraNote ? `\n\n${extraNote}` : ""}\n\nResponse: **HTTP ${res.status}**\n\`\`\`\n${headers.join("\n")}\n\n${redact(text).slice(0, 2500)}\n\`\`\`${decodedPaymentResponse}${decodedRequired}\n`;
  return { res, text, md };
}

const errOf = (res: Response): string => {
  const pr = res.headers.get("payment-required");
  if (!pr) return "";
  try {
    return ` error=${String(b64decode<Json>(pr)["error"])}`;
  } catch {
    return "";
  }
};
const { signer: agent, source } = signer();
const sections: string[] = [];
const verdicts: string[] = [];

// 0. the quote
const q = await record("Quote (402)", "GET", `${seller}/spike/report`, { method: "GET" });
sections.push(q.md);
let quote: Quote | undefined;
try {
  const hdr = q.res.headers.get("payment-required");
  const body = (hdr ? b64decode<{ accepts?: Quote[] }>(hdr) : (JSON.parse(q.text) as { accepts?: Quote[] }));
  quote = body.accepts?.find((a) => a.scheme === "exact" && a.network === "eip155:84532");
  sections.push(`Decoded PAYMENT-REQUIRED header:\n\`\`\`json\n${JSON.stringify(body, null, 2).slice(0, 1500)}\n\`\`\`\n`);
} catch {
  /* recorded below */
}
if (!quote) {
  sections.push(`The seller did not return an exact/eip155:84532 quote; cases (a)–(c) cannot run.\n`);
} else {
  const authFor = (validBefore: number): Promise<{ authorization: Authorization; signature: `0x${string}` }> =>
    (async () => {
      const now = Math.floor(Date.now() / 1000);
      const authorization: Authorization = { from: treasury, to: quote.payTo, value: quote.amount, validAfter: String(now - 600), validBefore: String(validBefore), nonce: randomNonce() };
      return { authorization, signature: await signAuthorization(agent, authorization) };
    })();
  const payload = (p: { authorization: Authorization; signature: `0x${string}` }) => ({
    x402Version: 2,
    scheme: "exact",
    network: "eip155:84532",
    accepted: quote, // must deep-equal the quoted entry (the official middleware rejects any extra field)
    payload: p,
  });

  // (a) with reserve
  const a = await authFor(Math.floor(Date.now() / 1000) + 300);
  const reserveBody = JSON.stringify({ paymentPayload: { payload: a }, paymentRequirements: { payTo: quote.payTo, amount: quote.amount, asset: quote.asset, network: quote.network } });
  let reserveNote: string;
  let reserved = false;
  try {
    const r = await record("(a) step 1: reserve through the Overflow facilitator", "POST", `${service}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: reserveBody });
    sections.push(r.md);
    const j = JSON.parse(r.text) as Json;
    reserved = j["success"] === true;
    reserveNote = reserved ? `Reservation confirmed in ${explorerUrl("tx", String(j["transaction"]))}.` : `**Reservation did not land** (${JSON.stringify(j["errorReason"] ?? j["error"] ?? j).slice(0, 200)}); the paid request below therefore runs without an onchain reservation.`;
  } catch (e) {
    reserveNote = `**Reservation step unavailable**: ${service}/reserve is unreachable (${e instanceof Error ? e.message : String(e)}). The paid request below therefore runs without an onchain reservation.`;
    sections.push(`#### (a) step 1: reserve through the Overflow facilitator\n\n\`POST ${service}/reserve\`\n\n${reserveNote}\n`);
  }
  const ra = await record(`(a) step 2: paid request ${reserved ? "with" : "WITHOUT (see step 1)"} a live reservation`, "GET", `${seller}/spike/report`, { method: "GET", headers: { "PAYMENT-SIGNATURE": b64encode(payload(a)) } }, reserveNote + `\n\nAuthorization digest \`${authorizationDigest(a.authorization)}\`, signer ${agent.address} (${source}).`);
  sections.push(ra.md);
  verdicts.push(`(a) ${reserved ? "with reserve" : "reserve unavailable"}: HTTP ${ra.res.status}${ra.res.headers.get("payment-response") ? ", PAYMENT-RESPONSE " + JSON.stringify(b64decode(ra.res.headers.get("payment-response")!)) : ", body " + redact(ra.text).slice(0, 160) + errOf(ra.res)}`);

  // (b) without reserve
  const b = await authFor(Math.floor(Date.now() / 1000) + 300);
  const rb = await record("(b) paid request without reserve", "GET", `${seller}/spike/report`, { method: "GET", headers: { "PAYMENT-SIGNATURE": b64encode(payload(b)) } }, `Fresh nonce, no reserve() call. Digest \`${authorizationDigest(b.authorization)}\`.`);
  sections.push(rb.md);
  verdicts.push(`(b) without reserve: HTTP ${rb.res.status}, body ${redact(rb.text).slice(0, 160)}${errOf(rb.res)}`);

  // (c) expired
  const c = await authFor(Math.floor(Date.now() / 1000) - 120);
  const rc = await record("(c) expired authorization (validBefore 2 minutes ago)", "GET", `${seller}/spike/report`, { method: "GET", headers: { "PAYMENT-SIGNATURE": b64encode(payload(c)) } }, `Stands in for an expired reservation: once validBefore passes, USDC and every facilitator refuse the authorization regardless of the treasury's reservation state. Digest \`${authorizationDigest(c.authorization)}\`.`);
  sections.push(rc.md);
  verdicts.push(`(c) expired: HTTP ${rc.res.status}, body ${redact(rc.text).slice(0, 160)}${errOf(rc.res)}`);
}

const out = resolve(repoRoot(), process.env["SPIKE_OUT"] ?? "docs/coinbase-feedback.md");
const header = (existsSync(out) ? readFileSync(out, "utf8").split("\n## Evidence")[0] : undefined) ?? `# Coinbase x402 facilitator with a policy-wallet payer (spike)\n`;
const md = [
  header.trimEnd(),
  "",
  "## Evidence",
  "",
  `Run \`pnpm spike:coinbase\` on ${new Date().toISOString()}. Seller: ${seller} (throwaway, official \`@x402/hono\` middleware, facilitator **${facilitatorName}**). Payer: treasury [${treasury}](${explorerUrl("address", treasury)}) on Base Sepolia, USDC ${USDC.address}. Signer: ${agent.address} (${source}).`,
  "",
  ...sections,
  "### Case summary",
  "",
  ...verdicts.map((v) => `- ${v}`),
  "",
].join("\n");
writeFileSync(out, md);
console.log(verdicts.join("\n"));
console.log(`wrote ${out}`);
