// ---------------------------------------------------------------------------
// Money mechanics (SPEC "Fusion" > Money mechanics): the merged purchase is
// signed by the lowest common ancestor (LCA) of the participating agents and
// charged up that chain once. Pure tree walk over the offchain agent records.
// ---------------------------------------------------------------------------

export interface AgentTreeNode {
  id: string;
  parentAgentId?: string | undefined;
  /** Treasury node id; undefined until the node exists onchain. */
  nodeId?: number | undefined;
}

export type PayerRule = "lca" | "lca-ancestor-with-node" | "mission-root";

export interface PayingNode {
  /** The LCA agent (or the ancestor whose node pays); null when the mission root pays without an agent. */
  agentId: string | null;
  nodeId: number;
  rule: PayerRule;
  evidence: string;
}

export class UnknownAgentError extends Error {
  constructor(public readonly agentId: string) {
    super(`agent ${agentId} is not in the agent tree`);
    this.name = "UnknownAgentError";
  }
}

export class AgentTreeCycleError extends Error {
  constructor(public readonly agentId: string) {
    super(`agent tree has a cycle through ${agentId}`);
    this.name = "AgentTreeCycleError";
  }
}

function pathToRoot(agentId: string, byId: ReadonlyMap<string, AgentTreeNode>): AgentTreeNode[] {
  const path: AgentTreeNode[] = [];
  let cur: AgentTreeNode | undefined = byId.get(agentId);
  if (!cur) throw new UnknownAgentError(agentId);
  while (cur) {
    if (path.length > byId.size) throw new AgentTreeCycleError(agentId);
    path.push(cur);
    cur = cur.parentAgentId === undefined ? undefined : byId.get(cur.parentAgentId);
  }
  return path.reverse(); // root first
}

/** Lowest common ancestor of `agentIds` in the tree; a single agent is its own LCA. */
export function lowestCommonAncestor(agentIds: readonly string[], agents: readonly AgentTreeNode[]): AgentTreeNode {
  const ids = [...new Set(agentIds)].sort();
  if (ids.length === 0) throw new Error("lowestCommonAncestor needs at least one agent");
  const byId = new Map(agents.map((a) => [a.id, a]));
  const paths = ids.map((id) => pathToRoot(id, byId));
  const first = paths[0]!;
  let depth = 0;
  while (depth < first.length && paths.every((p) => p[depth]?.id === first[depth]!.id)) depth++;
  const lca = first[depth - 1];
  if (!lca) throw new Error(`agents ${ids.join(", ")} share no ancestor`);
  return lca;
}

/**
 * The node that pays for a purchase shared by `agentIds`: the LCA's node; if
 * the LCA has no onchain node yet, the nearest ancestor that has one; if none
 * does, `fallbackNodeId` (the mission's root node).
 */
export function payingNode(agentIds: readonly string[], agents: readonly AgentTreeNode[], fallbackNodeId: number): PayingNode {
  const lca = lowestCommonAncestor(agentIds, agents);
  const byId = new Map(agents.map((a) => [a.id, a]));
  if (lca.nodeId !== undefined) {
    return { agentId: lca.id, nodeId: lca.nodeId, rule: "lca", evidence: `lowest common ancestor ${lca.id} pays from node ${lca.nodeId}` };
  }
  const path = pathToRoot(lca.id, byId); // root first
  for (let i = path.length - 2; i >= 0; i--) {
    const anc = path[i]!;
    if (anc.nodeId !== undefined) {
      return {
        agentId: anc.id,
        nodeId: anc.nodeId,
        rule: "lca-ancestor-with-node",
        evidence: `lowest common ancestor ${lca.id} has no onchain node; nearest ancestor ${anc.id} pays from node ${anc.nodeId}`,
      };
    }
  }
  return {
    agentId: null,
    nodeId: fallbackNodeId,
    rule: "mission-root",
    evidence: `lowest common ancestor ${lca.id} and its ancestors have no onchain node; mission root node ${fallbackNodeId} pays`,
  };
}
