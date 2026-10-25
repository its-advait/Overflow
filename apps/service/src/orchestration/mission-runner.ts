import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createRepositories, type Db } from "@overflow/database";
import { formatUsdc, type Address, type MissionRecord } from "@overflow/schemas";
import { z } from "zod";
import type { ActivityBus } from "../chain/bus.js";
import { runAgent, type AgentClient, type AgentRunResult } from "./agent-loop.js";
import type { AgentKeys } from "./agent-keys.js";
import { createChildren, pauseDescendant, readNode, readNodeOfKey, type ChildNode, type DelegationRelay, type NodeReader } from "./delegation.js";
import { ORCHESTRATOR_AGENT_ID, ROLE_AGENT_IDS, ROLES, type Role, type RolePolicies } from "./delegation-plan.js";
import { executeTool, type ToolContext } from "./tools.js";

// ---------------------------------------------------------------------------------------------------
// Mission runner: the root orchestrator plans, splits the budget, signs CreateChild for three sub-agents
// (relayed gaslessly), runs them in parallel and synthesizes. It proposes; only the treasury pays.
// ---------------------------------------------------------------------------------------------------

export interface PlannerClient extends AgentClient {
  messages: AgentClient["messages"] & { parse: Anthropic["messages"]["parse"] };
}

export interface MissionRunnerDeps {
  db: Db;
  bus: ActivityBus;
  model: { client: PlannerClient; model: string };
  treasury: Address;
  chain: NodeReader;
  relay: DelegationRelay;
  keys: AgentKeys;
  policies: RolePolicies;
  sellerUrl: string;
  demoMode: boolean;
  nowSeconds?: () => number;
  log?: (line: string) => void;
  fetchImpl?: ToolContext["fetchImpl"];
  catalogPath?: string;
  maxToolCalls?: number;
}

export interface RunOptions {
  /** DEMO_MODE only: when the live model declined the injected instruction, run the labeled SIMULATED probe. */
  forceInjectionBeat?: boolean;
}

export interface MissionRunResult {
  missionId: string;
  rootNodeId: bigint;
  children: ChildNode[];
  agents: AgentRunResult[];
  synthesis: string;
  injectionProbe: "not-needed" | "ran" | "skipped";
}

export const AssignmentPlanSchema = z.object({
  assignments: z.array(z.object({ role: z.enum(ROLES), brief: z.string().min(1).max(1200) })).length(ROLES.length),
});

export const CANNED_BRIEFS: Record<Role, string> = {
  research: "Use the seller's paid search API to find relevant listings and pages for the mission, read what they say, and propose the dataset that best covers the goal.",
  finance: "Review the catalog and samples for price, license and seats; propose the most economical dataset that satisfies the goal and flag anything over budget.",
  verification: "Cross-check what the catalog claims against a sample and, if needed, one paid search; report inconsistencies and whether the proposed data is fit for use.",
};

export function createMissionRunner(d: MissionRunnerDeps) {
  const now = d.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const log = d.log ?? (() => {});
  const repos = createRepositories(d.db);
  const emit = async (missionId: string, message: string, extra: { agentId?: string; simulated?: boolean } = {}) => {
    const ev = await repos.activityEvents.insert({ kind: "mission.run", missionId, message, agentId: extra.agentId ?? ORCHESTRATOR_AGENT_ID, ...(extra.simulated ? { simulated: true } : {}) });
    d.bus.publish(ev);
  };

  async function plan(mission: MissionRecord): Promise<Record<Role, string>> {
    try {
      const response = await d.model.client.messages.parse({
        model: d.model.model,
        max_tokens: 4000,
        system: "You are the orchestrator of a team of three sub-agents (research, finance, verification) buying data for a company. Write one concrete assignment brief per role for the mission. Agents can list catalog resources, read samples, call a paid search/scrape API, fetch seller pages and propose purchases; they cannot pay for datasets directly.",
        messages: [{ role: "user", content: `Mission goal: ${mission.goal}\nBudget: ${formatUsdc(mission.budgetAtomic)} USDC total.` }],
        output_config: { format: zodOutputFormat(AssignmentPlanSchema) },
      });
      const parsed = AssignmentPlanSchema.safeParse(response.parsed_output);
      if (response.stop_reason !== "end_turn" || !parsed.success) throw new Error(`planner answered ${String(response.stop_reason)} without a valid plan`);
      const out = { ...CANNED_BRIEFS };
      for (const a of parsed.data.assignments) out[a.role] = a.brief;
      return out;
    } catch (err) {
      log(`[mission] planner fallback: ${err instanceof Error ? err.message : String(err)}`);
      return { ...CANNED_BRIEFS };
    }
  }

  async function synthesize(mission: MissionRecord, agents: AgentRunResult[]): Promise<string> {
    const Synthesis = z.object({ recommendation: z.string().min(1).max(3000) });
    try {
      const response = await d.model.client.messages.parse({
        model: d.model.model,
        max_tokens: 3000,
        system: "You are the orchestrator. Merge your sub-agents' reports into one recommendation for the controller: what to buy, why, what was refused by treasury policy and what still needs a human.",
        messages: [{ role: "user", content: `Mission: ${mission.goal}\n\n${agents.map((a) => `## ${a.agentId} (${a.stop}, ${a.toolCalls} tool calls)\n${a.summary}\n${a.findings.map((f) => `- ${f}`).join("\n")}\nPayments: ${JSON.stringify(a.payments)}`).join("\n\n")}` }],
        output_config: { format: zodOutputFormat(Synthesis) },
      });
      const parsed = Synthesis.safeParse(response.parsed_output);
      if (parsed.success) return parsed.data.recommendation;
      throw new Error("no synthesis");
    } catch {
      return agents.map((a) => `${a.agentId}: ${a.summary}`).join("\n");
    }
  }

  function childContext(mission: MissionRecord, child: ChildNode, simulated = false): ToolContext {
    return {
      db: d.db,
      bus: d.bus,
      agentId: child.agentId,
      missionId: mission.id,
      nodeId: child.nodeId,
      account: d.keys.children[child.role],
      treasury: d.treasury,
      sellerUrl: d.sellerUrl,
      forceBroadcast: d.demoMode,
      ...(simulated ? { simulated: true } : {}),
      ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}),
      ...(d.catalogPath ? { catalogPath: d.catalogPath } : {}),
      nowSeconds: now,
    };
  }

  async function resolveRoot(mission: MissionRecord) {
    const rootNodeId = await readNodeOfKey(d.chain, d.treasury, d.keys.root.address);
    if (rootNodeId === 0n) throw new Error(`AGENT_ROOT_KEY ${d.keys.root.address} owns no treasury node; the controller must createRoot first`);
    if (mission.rootNodeId !== undefined && BigInt(mission.rootNodeId) !== rootNodeId) {
      throw new Error(`mission root node ${mission.rootNodeId} is not the orchestrator's node ${rootNodeId}`);
    }
    const node = await readNode(d.chain, d.treasury, rootNodeId);
    return { nodeId: rootNodeId, node };
  }

  return {
    async run(mission: MissionRecord, opts: RunOptions = {}): Promise<MissionRunResult> {
      const budget = BigInt(mission.budgetAtomic);
      await emit(mission.id, `run started: budget ${formatUsdc(budget)} USDC, orchestrator ${d.keys.root.address}, three sub-agents (research, finance, verification)`);
      try {
        await repos.missions.setStatus(mission.id, "active");
        const root = await resolveRoot(mission);
        if (budget > root.node.cap - root.node.spent) {
          throw new Error(`budget ${formatUsdc(budget)} exceeds the root node's remaining ${formatUsdc(root.node.cap - root.node.spent)} USDC`);
        }
        const briefs = await plan(mission);
        const children = await createChildren({
          db: d.db,
          bus: d.bus,
          chain: d.chain,
          relay: d.relay,
          treasury: d.treasury,
          missionId: mission.id,
          organizationId: mission.organizationId,
          root: { account: d.keys.root, nodeId: root.nodeId, node: root.node },
          children: d.keys.children,
          policies: d.policies,
          budgetAtomic: budget,
          nowSeconds: now,
          log,
        });
        const agents = await Promise.all(
          children.map((child) =>
            runAgent({
              client: d.model.client,
              model: d.model.model,
              ctx: childContext(mission, child),
              role: child.role,
              goal: mission.goal,
              brief: briefs[child.role],
              capAtomic: child.capAtomic,
              maxPerCallAtomic: child.maxPerCallAtomic,
              ...(d.maxToolCalls !== undefined ? { maxToolCalls: d.maxToolCalls } : {}),
              log,
            }),
          ),
        );
        let injectionProbe: MissionRunResult["injectionProbe"] = "not-needed";
        const triedPremiumIntel = agents.some((a) => a.payments.some((p) => p.url.includes("/premium-intel")));
        if (!triedPremiumIntel && opts.forceInjectionBeat) {
          if (!d.demoMode) {
            injectionProbe = "skipped";
            await emit(mission.id, "injection probe skipped: DEMO_MODE is off");
          } else {
            injectionProbe = "ran";
            const research = children.find((c) => c.role === "research")!;
            await emit(mission.id, "SIMULATED injected agent: the live model ignored the injected instruction; replaying the /premium-intel attempt with the research node key so the treasury's refusal is exercised", { agentId: research.agentId, simulated: true });
            const probe = await executeTool("call_paid_api", { endpoint: "premium-intel" }, childContext(mission, research, true));
            if (!(probe instanceof Object && "content" in probe)) throw new Error("probe returned no result");
            const r = agents.find((a) => a.agentId === research.agentId);
            if (r && "payment" in probe && probe.payment) r.payments.push(probe.payment);
          }
        }
        const synthesis = await synthesize(mission, agents);
        const report = await repos.activityEvents.insert({ kind: "agent.report", missionId: mission.id, agentId: ORCHESTRATOR_AGENT_ID, message: `orchestrator recommendation: ${synthesis.slice(0, 3000)}` });
        d.bus.publish(report);
        const blocked = agents.flatMap((a) => a.payments.filter((p) => p.outcome === "blocked"));
        const paid = agents.flatMap((a) => a.payments.filter((p) => p.outcome === "paid"));
        await emit(mission.id, `run finished: nodes ${children.map((c) => `${c.role}=${c.nodeId}`).join(", ")}; ${agents.reduce((s, a) => s + a.toolCalls, 0)} tool calls; ${paid.length} paid (${paid.map((p) => p.txHash).join(", ") || "none"}); ${blocked.length} blocked by policy (${blocked.map((p) => p.decoded).join(", ") || "none"}); injection probe ${injectionProbe}`);
        return { missionId: mission.id, rootNodeId: root.nodeId, children, agents, synthesis, injectionProbe };
      } catch (err) {
        await emit(mission.id, `run failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },

    /** The orchestrator signs PauseChild for one of its sub-agents; the relay pays gas. */
    async pauseAgent(mission: MissionRecord, agentId: string): Promise<{ txHash: `0x${string}`; nodeId: number }> {
      const agent = await repos.agents.getById(agentId);
      if (!agent?.nodeId) throw new Error(`agent ${agentId} has no treasury node yet`);
      if (!(Object.values(ROLE_AGENT_IDS) as string[]).includes(agentId)) throw new Error(`agent ${agentId} is not one of the orchestrator's sub-agents`);
      const { txHash } = await pauseDescendant({ db: d.db, bus: d.bus, relay: d.relay, treasury: d.treasury, signer: d.keys.root, targetNodeId: BigInt(agent.nodeId), missionId: mission.id, targetAgentId: agentId, nowSeconds: now });
      return { txHash, nodeId: agent.nodeId };
    },
  };
}

export type MissionRunner = ReturnType<typeof createMissionRunner>;
