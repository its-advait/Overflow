import type { ActivityEvent, PurchaseGroup, PurchaseRecord } from "@overflow/schemas";

// Mission detail read models, all derived from stored activity events and
// stored purchase rows. Nothing here is a local flag: a count is a count of
// events the service wrote, an output is an agent.report event, a
// recommendation is an oracle/fusion event or the reason stored on a purchase.

export interface AgentProgress {
  agentId: string;
  toolCalls: number;
  toolResults: number;
  /** Tool results the agent loop marked " ERROR" (apps/service/src/orchestration/agent-loop.ts). */
  errors: number;
  /** policy.blocked events attributed to this agent: treasury reverts, decoded. */
  blocked: number;
  reports: number;
  lastAt?: string;
  lastMessage?: string;
}

/** Per-agent progress for every agent that appears in the mission's events, newest activity first. */
export function agentProgress(events: readonly ActivityEvent[]): AgentProgress[] {
  const byAgent = new Map<string, AgentProgress>();
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  for (const e of sorted) {
    if (!e.agentId) continue;
    const p = byAgent.get(e.agentId) ?? { agentId: e.agentId, toolCalls: 0, toolResults: 0, errors: 0, blocked: 0, reports: 0 };
    if (e.kind === "agent.tool_call") p.toolCalls++;
    if (e.kind === "agent.tool_result") {
      p.toolResults++;
      if (/ ERROR:/.test(e.message)) p.errors++;
    }
    if (e.kind === "policy.blocked") p.blocked++;
    if (e.kind === "agent.report") p.reports++;
    p.lastAt = e.at;
    p.lastMessage = e.message;
    byAgent.set(e.agentId, p);
  }
  return [...byAgent.values()].sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
}

export type RunState = "not started" | "running" | "finished" | "failed";

/** From the last mission.run event, in the runner's own words ("run started", "run finished", "run failed"). */
export function runState(events: readonly ActivityEvent[]): RunState {
  const runs = events.filter((e) => e.kind === "mission.run").sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const last = runs[runs.length - 1];
  if (!last) return "not started";
  const text = last.message.replace(/^MOCK: /, "");
  if (text.startsWith("run finished")) return "finished";
  if (text.startsWith("run failed")) return "failed";
  return "running";
}

export interface Recommendation {
  source: "oracle" | "fusion" | "stored";
  at: string;
  text: string;
  agentId?: string;
  purchaseId?: string;
  simulated: boolean;
}

/** Oracle and Fusion decisions written as events, plus the reason stored on each purchase and group. Newest first. */
export function recommendations(events: readonly ActivityEvent[], purchases: readonly PurchaseRecord[], groups: readonly PurchaseGroup[]): Recommendation[] {
  const rows: Recommendation[] = [];
  for (const e of events) {
    if (e.kind === "oracle.recommendation" || e.kind === "fusion.decision") {
      rows.push({
        source: e.kind === "oracle.recommendation" ? "oracle" : "fusion",
        at: e.at,
        text: e.message,
        simulated: e.simulated,
        ...(e.agentId ? { agentId: e.agentId } : {}),
        ...(e.purchaseId ? { purchaseId: e.purchaseId } : {}),
      });
    }
  }
  const seen = new Set(rows.map((r) => r.text));
  for (const p of purchases) {
    const group = groups.find((g) => g.id === p.purchaseGroupId);
    for (const text of [p.oracleReason, group?.mergeReason]) {
      if (!text || seen.has(text)) continue;
      seen.add(text);
      rows.push({ source: "stored", at: p.updatedAt, text, purchaseId: p.id, simulated: false });
    }
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

export interface AgentOutput {
  agentId: string;
  at: string;
  /** True for the orchestrator's synthesis ("orchestrator recommendation: ..."). */
  synthesis: boolean;
  summary: string;
  findings: string[];
}

/** agent.report events as the runner writes them: "<agent> report: <summary> | findings: <list>" or "orchestrator recommendation: <text>". */
export function outputs(events: readonly ActivityEvent[]): AgentOutput[] {
  const out: AgentOutput[] = [];
  for (const e of events) {
    if (e.kind !== "agent.report") continue;
    const agentId = e.agentId ?? "unknown";
    if (e.message.startsWith("orchestrator recommendation: ")) {
      out.push({ agentId, at: e.at, synthesis: true, summary: e.message.slice("orchestrator recommendation: ".length), findings: [] });
      continue;
    }
    const body = e.message.replace(/^[^:]*report: /, "");
    const [summary, findingsText] = body.split(" | findings: ");
    out.push({ agentId, at: e.at, synthesis: false, summary: summary ?? body, findings: parseFindings(findingsText) });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

function parseFindings(text: string | undefined): string[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // clipped JSON or plain text: keep it as one finding
  }
  return [text];
}
