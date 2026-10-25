import { describe, expect, it } from "vitest";
import { lowestCommonAncestor, payingNode, UnknownAgentError, type AgentTreeNode } from "./payer";

const orchestrator: AgentTreeNode = { id: "agent-orchestrator" };
const research: AgentTreeNode = { id: "agent-research", parentAgentId: "agent-orchestrator" };
const finance: AgentTreeNode = { id: "agent-finance", parentAgentId: "agent-orchestrator" };
const intern: AgentTreeNode = { id: "agent-intern", parentAgentId: "agent-research" };
const tree = [orchestrator, research, finance, intern];
const withNodes = (ids: Record<string, number>): AgentTreeNode[] => tree.map((a) => ({ ...a, nodeId: ids[a.id] }));

describe("payingNode: lowest common ancestor", () => {
  it("research and finance share the orchestrator as parent, so the orchestrator's node pays", () => {
    expect(lowestCommonAncestor(["agent-finance", "agent-research"], tree).id).toBe("agent-orchestrator");
    const p = payingNode(["agent-research", "agent-finance"], withNodes({ "agent-orchestrator": 1, "agent-research": 2, "agent-finance": 3 }), 1);
    expect(p).toMatchObject({ agentId: "agent-orchestrator", nodeId: 1, rule: "lca" });
  });

  it("a single agent is its own LCA and pays from its own node", () => {
    const p = payingNode(["agent-research"], withNodes({ "agent-orchestrator": 1, "agent-research": 2 }), 1);
    expect(p).toMatchObject({ agentId: "agent-research", nodeId: 2, rule: "lca" });
  });

  it("intern and research resolve to research (the deeper common ancestor), duplicates ignored", () => {
    const p = payingNode(["agent-intern", "agent-research", "agent-intern"], withNodes({ "agent-orchestrator": 1, "agent-research": 2, "agent-intern": 4 }), 1);
    expect(p).toMatchObject({ agentId: "agent-research", nodeId: 2, rule: "lca" });
  });

  it("an LCA without an onchain node defers to the nearest ancestor that has one", () => {
    const p = payingNode(["agent-intern", "agent-research"], withNodes({ "agent-orchestrator": 1 }), 9);
    expect(p).toMatchObject({ agentId: "agent-orchestrator", nodeId: 1, rule: "lca-ancestor-with-node" });
    expect(p.evidence).toContain("agent-research has no onchain node");
  });

  it("no node anywhere up the chain: the mission root pays and the evidence says so", () => {
    const p = payingNode(["agent-research", "agent-finance"], tree, 1);
    expect(p).toMatchObject({ agentId: null, nodeId: 1, rule: "mission-root" });
    expect(p.evidence).toContain("mission root node 1 pays");
  });

  it("an unknown agent is an error, not a guess", () => {
    expect(() => payingNode(["agent-ghost"], tree, 1)).toThrow(UnknownAgentError);
  });
});
