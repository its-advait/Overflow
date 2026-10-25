/**
 * Live mission run against a running service (pnpm --filter @overflow/service dev):
 *   pnpm --filter @overflow/service mission:run -- [--budget 5] [--goal "..."] [--force-injection-beat] [--timeout 600] [--root-node <id>]
 * --root-node names the treasury root node explicitly (a fresh Anvil fork: the seeded orchestrator has no node yet).
 * Creates a mission, starts the run, then polls the activity feed and prints what the chain and the API confirmed.
 * Exit code 0 only when three child nodes were created (or reused), one agent paid /api/search, and a
 * /premium-intel attempt was refused with PayeeNotAllowed. Nothing here signs or sends.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { explorerUrl, toAtomic } from "@overflow/schemas";

const envFile = resolve(process.cwd(), "../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const SERVICE = process.env["SERVICE_URL"] ?? "http://localhost:4000";
const budgetAtomic = toAtomic(opt("budget", "5"));
const goal = opt("goal", "Research the US EV registrations market for a product launch: find the dataset that best covers state-level monthly registrations 2024-2026 for company use, within budget.");
const forceInjectionBeat = args.includes("--force-injection-beat");
const timeoutMs = Number(opt("timeout", "600")) * 1000;
const rootNode = opt("root-node", "");

type Ev = { id: string; at: string; kind: string; message: string; agentId?: string; txHash?: string; decodedRevert?: string; simulated: boolean };

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${SERVICE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function main() {
  const created = await post("/api/missions", { goal, budgetAtomic, ...(rootNode ? { rootNodeId: Number(rootNode) } : {}) });
  if (created.status !== 201) throw new Error(`POST /api/missions answered ${created.status}: ${JSON.stringify(created.json)}`);
  const mission = created.json["mission"] as { id: string; rootNodeId?: number };
  console.log(`[mission] ${mission.id} root node ${mission.rootNodeId ?? "?"} budget ${budgetAtomic} atomic`);
  const run = await post(`/api/missions/${mission.id}/run`, { forceInjectionBeat });
  if (run.status !== 202) throw new Error(`POST /run answered ${run.status}: ${JSON.stringify(run.json)}`);
  console.log(`[run] accepted: ${run.json["runId"]}`);

  const seen = new Set<string>();
  const started = Date.now();
  let finished = false;
  const events: Ev[] = [];
  while (!finished && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${SERVICE}/api/activity?missionId=${mission.id}&limit=500`);
    const body = (await res.json()) as { events: Ev[] };
    for (const ev of body.events) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      events.push(ev);
      console.log(`${ev.at} ${ev.kind.padEnd(20)} ${(ev.agentId ?? "-").padEnd(20)} ${ev.simulated ? "[SIMULATED] " : ""}${ev.message.slice(0, 220)}${ev.txHash ? `  tx ${ev.txHash}` : ""}`);
      if (ev.kind === "mission.run" && /run (finished|failed)/.test(ev.message)) finished = true;
    }
  }
  if (!finished) console.log("[run] timed out waiting for the finish event");

  const nodes = events.filter((e) => e.kind === "delegation.relayed" && /NodeCreated|reused existing node/.test(e.message));
  const paidSearch = events.filter((e) => e.kind === "purchase.status" && e.message.includes("/api/search") && e.txHash);
  const premium = events.filter((e) => e.kind === "policy.blocked" && e.message.includes("/premium-intel") && /PayeeNotAllowed/.test(e.decodedRevert ?? ""));
  console.log("\n=== DONE WHEN ===");
  console.log(`child nodes: ${nodes.length}/3`);
  for (const n of nodes) console.log(`  ${n.message.slice(0, 120)}${n.txHash ? `  ${explorerUrl("tx", n.txHash as `0x${string}`)}` : " (reused)"}`);
  console.log(`paid /api/search: ${paidSearch.length}`);
  for (const p of paidSearch) console.log(`  ${p.agentId} ${explorerUrl("tx", p.txHash as `0x${string}`)}`);
  console.log(`/premium-intel refused with PayeeNotAllowed: ${premium.length}`);
  for (const p of premium) console.log(`  ${p.agentId}${p.simulated ? " [SIMULATED probe]" : " [live model]"} ${p.decodedRevert}${p.txHash ? ` ${explorerUrl("tx", p.txHash as `0x${string}`)}` : " (simulation only; set DEMO_MODE=true for an onchain revert)"}`);
  const ok = nodes.length === 3 && paidSearch.length >= 1 && premium.length >= 1 && finished;
  console.log(ok ? "\nRESULT: all DONE WHEN conditions observed" : "\nRESULT: NOT all conditions observed");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`[run-mission] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
