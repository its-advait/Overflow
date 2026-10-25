import { AgentRecordSchema, ControllerRequestSchema, IdSchema, type AgentRecord } from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { ApiError, parseBody, parseParams, respond, type ApiEnv } from "../http.js";

/**
 * Agent tree. Onchain node state (cap, spent, paused, expiry) is NOT fabricated
 * here: `node` is null until the chain module reads the treasury. Only the
 * offchain records and their parent links are returned.
 */
type AgentTreeNode = AgentRecord & { node: null; children: AgentTreeNode[] };
const AgentTreeNodeSchema: z.ZodType<AgentTreeNode> = AgentRecordSchema.extend({
  node: z.null(),
  children: z.lazy(() => z.array(AgentTreeNodeSchema)),
}) as z.ZodType<AgentTreeNode>;

const TreeResponse = z.object({ agents: z.array(AgentRecordSchema), tree: z.array(AgentTreeNodeSchema) });
const PauseBody = z.object({ reason: z.string().min(1).max(500) });
const PauseResponse = z.object({ request: ControllerRequestSchema });
const IdParams = z.object({ id: IdSchema });

export function buildTree(agents: AgentRecord[]): AgentTreeNode[] {
  const nodes = new Map<string, AgentTreeNode>(agents.map((a) => [a.id, { ...a, node: null, children: [] }]));
  const roots: AgentTreeNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentAgentId ? nodes.get(n.parentAgentId) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

export function agentRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();

  app.get("/", async (c) => {
    const agents = await deps.repos.agents.listByOrganization(c.get("session").organizationId);
    return respond(c, TreeResponse, { agents, tree: buildTree(agents) });
  });

  /**
   * Pause opens a controller approval. It records a ControllerRequest the
   * human approves in Coinbase Wallet (P4.5); the treasury's `pause(nodeId)`
   * emits NodePaused and only that event makes the agent paused. No local
   * flag is written anywhere.
   */
  app.post("/:id/pause", async (c) => {
    const { id } = parseParams(c, IdParams);
    const body = await parseBody(c, PauseBody);
    const session = c.get("session");
    const agent = await deps.repos.agents.getById(id);
    if (!agent || agent.organizationId !== session.organizationId) {
      throw new ApiError(404, "not_found", `agent ${id} not found`);
    }
    if (!agent.nodeId) {
      throw new ApiError(409, "no_node_yet", `agent ${id} has no treasury node onchain yet; there is nothing to pause`);
    }
    const request = await deps.repos.controllerRequests.insert({
      action: { kind: "pause", nodeId: agent.nodeId },
      requestedBy: session.principal,
      reason: body.reason,
    });
    await deps.repos.activityEvents.insert({
      kind: "controller.requested",
      message: `pause requested for node ${agent.nodeId} (${agent.name}): ${body.reason}; awaiting controller approval`,
      agentId: agent.id,
    });
    return respond(c, PauseResponse, { request }, 202);
  });

  return app;
}
