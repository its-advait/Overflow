import type Anthropic from "@anthropic-ai/sdk";
import { createRepositories } from "@overflow/database";
import { formatUsdc } from "@overflow/schemas";
import { AGENT_TOOLS, clip, executeTool, ToolDone, type ToolContext, type ToolResult } from "./tools.js";

/** The slice of the Anthropic client the loop uses; tests pass a scripted fake. */
export interface AgentClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface RunAgentInput {
  client: AgentClient;
  model: string;
  ctx: ToolContext;
  role: string;
  goal: string;
  brief: string;
  capAtomic: bigint;
  maxPerCallAtomic: bigint;
  maxToolCalls?: number;
  maxTokens?: number;
  log?: (line: string) => void;
}

export interface AgentRunResult {
  agentId: string;
  summary: string;
  findings: string[];
  toolCalls: number;
  payments: NonNullable<ToolResult["payment"]>[];
  stop: "report" | "end_turn" | "limit" | "max_tokens" | "refusal";
}

export const DEFAULT_MAX_TOOL_CALLS = 8;

export function systemPrompt(i: Pick<RunAgentInput, "role" | "goal" | "brief" | "capAtomic" | "maxPerCallAtomic" | "ctx">, maxToolCalls: number): string {
  return [
    `You are the ${i.role} sub-agent of an Overflow mission. Mission goal: "${i.goal}".`,
    `Your assignment from the orchestrator: ${i.brief}`,
    `You hold treasury node ${i.ctx.nodeId} with a budget of ${formatUsdc(i.capAtomic)} USDC and at most ${formatUsdc(i.maxPerCallAtomic)} USDC per call. Paid tools spend real treasury USDC; the treasury's policy may refuse a payment, and a refusal is final for that payee.`,
    `Use at most ${maxToolCalls} tool calls, then call report_findings exactly once with what you learned and what you propose. You cannot pay for datasets yourself: propose_purchase files a request for the Oracle and Fusion.`,
  ].join("\n");
}

/**
 * Manual tool-use loop (Anthropic Messages API). Every tool call and every result is an activity event with the
 * agent id. All results of one assistant turn go back in one user message. No retries of uncertain payments.
 */
export async function runAgent(i: RunAgentInput): Promise<AgentRunResult> {
  const maxToolCalls = i.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const repos = createRepositories(i.ctx.db);
  const log = i.log ?? (() => {});
  const emit = async (kind: "agent.tool_call" | "agent.tool_result", message: string) => {
    const ev = await repos.activityEvents.insert({ kind, message, agentId: i.ctx.agentId, missionId: i.ctx.missionId, ...(i.ctx.simulated ? { simulated: true } : {}) });
    i.ctx.bus.publish(ev);
  };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "Begin your assignment." }];
  const payments: AgentRunResult["payments"] = [];
  let toolCalls = 0;
  for (let turn = 0; turn < maxToolCalls + 2; turn++) {
    const response = await i.client.messages.create({
      model: i.model,
      max_tokens: i.maxTokens ?? 8000,
      system: systemPrompt(i, maxToolCalls),
      tools: AGENT_TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });
    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      log(`[agent ${i.ctx.agentId}] stopped: ${response.stop_reason}`);
      return { agentId: i.ctx.agentId, summary: text || `(stopped: ${response.stop_reason})`, findings: [], toolCalls, payments, stop: response.stop_reason };
    }
    if (uses.length === 0) return { agentId: i.ctx.agentId, summary: text || "(no report)", findings: [], toolCalls, payments, stop: "end_turn" };

    const results: Anthropic.ToolResultBlockParam[] = [];
    let done: ToolDone | undefined;
    for (const use of uses) {
      await emit("agent.tool_call", `${use.name} ${clip(use.input, 1500)}`);
      let result: ToolResult | ToolDone;
      if (use.name !== "report_findings" && toolCalls >= maxToolCalls) {
        result = { content: "Tool-call limit reached. Call report_findings now.", isError: true };
      } else {
        if (use.name !== "report_findings") toolCalls++;
        try {
          result = await executeTool(use.name, use.input, i.ctx);
        } catch (err) {
          result = { content: `Tool ${use.name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }
      if (result instanceof ToolDone) {
        done = result;
        await emit("agent.tool_result", `report_findings accepted`);
        results.push({ type: "tool_result", tool_use_id: use.id, content: "Report received. You are done." });
        continue;
      }
      if (result.payment) payments.push(result.payment);
      await emit("agent.tool_result", `${use.name}${result.isError ? " ERROR" : ""}: ${clip(result.content, 1500)}`);
      results.push({ type: "tool_result", tool_use_id: use.id, content: result.content, ...(result.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
    if (done) return { agentId: i.ctx.agentId, summary: done.summary, findings: done.findings, toolCalls, payments, stop: "report" };
  }
  return { agentId: i.ctx.agentId, summary: "(stopped: turn limit reached without a report)", findings: [], toolCalls, payments, stop: "limit" };
}
