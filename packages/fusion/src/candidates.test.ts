import { describe, expect, it } from "vitest";
import { candidateGroups, candidatePairs, topicKeywords } from "./candidates";
import { AGENT_A, AGENT_B } from "./fixtures.test-helper";

const steel = { ...AGENT_B, id: "req-c", agentId: "agent-finance", topic: "Steel prices" };
const evTexas = { ...AGENT_A, id: "req-d", topic: "Texas EV registrations" };

describe("stage 1: keyword candidates", () => {
  it("normalizes topics to sorted keywords without stop words", () => {
    expect(topicKeywords("The EV registrations of California, dataset")).toEqual(["california", "ev", "registrations"]);
  });

  it("pairs requests whose topics overlap and skips the rest, sorted by id", () => {
    const pairs = candidatePairs([steel, AGENT_B, AGENT_A]);
    expect(pairs).toEqual([{ a: "req-a", b: "req-b", shared: ["ev", "registrations"] }]);
  });

  it("groups transitively; a lone topic forms no group", () => {
    expect(candidateGroups([steel, evTexas, AGENT_B, AGENT_A])).toEqual([["req-a", "req-b", "req-d"]]);
    expect(candidateGroups([steel, AGENT_A])).toEqual([]);
  });

  it("minShared raises the bar", () => {
    expect(candidatePairs([AGENT_A, AGENT_B], { minShared: 3 })).toEqual([]);
  });
});
