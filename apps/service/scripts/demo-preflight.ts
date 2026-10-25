/**
 * Demo preflight: green/red checks before a live demo. Read-only: nothing is signed or sent.
 *   pnpm demo:preflight
 * 1. Chain, contracts, treasury USDC, relayer and seller gas, keys and allowlist: scripts/preflight.ts (its table prints first).
 * 2. Service API (GET /), seller service (GET /health, GET /sellers), SSE (GET /events delivers an event), model API.
 * Exit 0 only when every row is green. Secrets are never printed.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv, readConfig } from "../src/config.js";

type Row = { check: string; ok: boolean; detail: string };
const rows: Row[] = [];
const add = (check: string, ok: boolean, detail: string) => rows.push({ check, ok, detail });
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const RESET = "\u001b[0m";

async function getJson(url: string, timeoutMs = 5000): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function sseDelivers(url: string, timeoutMs = 6000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "text/event-stream" } });
    if (res.status !== 200 || !res.body) return `HTTP ${res.status}`;
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value ?? new Uint8Array());
    const ev = /event: *(\w+)/.exec(text)?.[1];
    return ev ? `ok: first event "${ev}"` : "connected but no event in the first chunk";
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

async function main(): Promise<number> {
  loadEnv();
  // 1. Chain-side checks (existing read-only preflight).
  const chain = spawnSync("pnpm", ["exec", "tsx", "scripts/preflight.ts", ...process.argv.slice(2)], { stdio: "inherit", cwd: process.cwd() });
  add("chain, contracts, treasury USDC, relayer + seller gas, keys (preflight.ts)", chain.status === 0, chain.status === 0 ? "all rows PASS (table above)" : "FAIL rows in the table above");

  const service = (process.env["SERVICE_URL"] || "http://localhost:4000").replace(/\/$/, "");
  const seller = (process.env["SELLER_URL"] || "http://localhost:4100").replace(/\/$/, "");

  // 2. Service API and its modules.
  try {
    const r = await getJson(`${service}/`);
    const modules = (r.json["modules"] ?? {}) as Record<string, string>;
    const scripted = r.json["scripted"] as { mode?: string } | undefined;
    add("service API (GET /)", r.status === 200, `${service} HTTP ${r.status}; scripted mode ${scripted?.mode ?? "unknown"}`);
    add("purchase flow wired (modules.flow)", /^live/.test(modules["flow"] ?? ""), (modules["flow"] ?? "missing").slice(0, 160));
    add("mission runner wired", /mission runner live/.test(modules["orchestration"] ?? ""), (modules["orchestration"] ?? "missing").split("mission runner ")[1]?.slice(0, 120) ?? "missing");
  } catch (e) {
    add("service API (GET /)", false, `${service} unreachable: ${e instanceof Error ? e.message : String(e)} (start: pnpm --filter @overflow/service dev)`);
  }

  // 3. SIMULATED seller service.
  try {
    const h = await getJson(`${seller}/health`);
    add("seller service (GET /health)", h.status === 200, `${seller} HTTP ${h.status}`);
    const s = await getJson(`${seller}/sellers`);
    const list = (s.json["sellers"] ?? []) as { id?: string; behavior?: string }[];
    add("SIMULATED Recourse sellers (GET /sellers)", s.status === 200 && list.length > 0, s.status === 200 ? list.map((x) => `${x.id}=${x.behavior}`).join(", ") || "none" : `HTTP ${s.status}`);
  } catch (e) {
    add("seller service (GET /health)", false, `${seller} unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4. SSE feed.
  try {
    const sse = await sseDelivers(`${service}/events?replay=0`);
    add("SSE (GET /events)", sse.startsWith("ok"), sse);
  } catch (e) {
    add("SSE (GET /events)", false, e instanceof Error ? e.message : String(e));
  }

  // 5. Model API (or the replay recording when DEMO_SCRIPTED=replay: the API is never called then).
  let config: ReturnType<typeof readConfig> | null = null;
  try {
    config = readConfig();
  } catch {
    /* reported by preflight.ts */
  }
  if (config?.scripted.mode === "replay") {
    add("model: SCRIPTED replay recording", existsSync(config.scripted.file), existsSync(config.scripted.file) ? config.scripted.file : `missing ${config.scripted.file} (record it first with DEMO_SCRIPTED=record)`);
  } else {
    const model = process.env["CLAUDE_MODEL"]?.trim();
    if (!process.env["ANTHROPIC_API_KEY"] || !model) add("model API (Anthropic)", false, "ANTHROPIC_API_KEY / CLAUDE_MODEL unset");
    else {
      try {
        const m = await new Anthropic().models.retrieve(model);
        add("model API (Anthropic)", true, `models.retrieve(${model}) -> ${m.id}`);
      } catch (e) {
        add("model API (Anthropic)", false, `models.retrieve(${model}) failed: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
      }
    }
  }

  console.log("\n=== demo preflight ===");
  for (const r of rows) console.log(`${r.ok ? `${GREEN}✔ PASS` : `${RED}✘ FAIL`}${RESET}  ${r.check}: ${r.detail}`);
  const failed = rows.filter((r) => !r.ok).length;
  console.log(failed === 0 ? `\n${GREEN}READY: every check is green${RESET}` : `\n${RED}NOT READY: ${failed} red check(s)${RESET}`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`[demo-preflight] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
