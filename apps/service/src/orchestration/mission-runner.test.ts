import type Anthropic from "@anthropic-ai/sdk";
import { createChildDigest } from "@overflow/payment-client";
import type { ChildParams, PauseChild } from "@overflow/payment-client";
import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActivityBus } from "../chain/bus.js";
import type { SettleInput, SettleOutcome } from "../facilitator/settle.js";
import { createSellerApp } from "../sellers/app.js";
import type { SellerConfig } from "../sellers/config.js";
import { LISTING_PATH } from "../sellers/listing.js";
import { ATTACKER, TREASURY, testDatabase } from "../test-db.js";
import { seedCatalog } from "./catalog.js";
import { createChildren, relayViaApp, type DelegationRelay, type RelayAnswer } from "./delegation.js";
import { resolveRolePolicies, ROLE_AGENT_IDS, type TreasuryNode } from "./delegation-plan.js";
import { createMissionRunner, type PlannerClient } from "./mission-runner.js";

const SELLER_URL = "http://seller.test";
const SEARCH = "0x2222222222222222222222222222222222222222" as const;
const SCRAPE = "0x3333333333333333333333333333333333333333" as const;
const TX = `0x${"ab".repeat(32)}` as Hex;
const NOW = 1_800_000_000;
const key = (label: string) => privateKeyToAccount(keccak256(toBytes(label)));
const keys = { root: key("root"), rootSource: "test", children: { research: key("research"), finance: key("finance"), verification: key("verification") } };
const rootNode: TreasuryNode = { key: keys.root.address, parent: 0n, depth: 0n, cap: 50_000_000n, spent: 0n, maxPerCall: 15_000_000n, expiry: BigInt(NOW + 7 * 86_400), paused: false, restricted: false };
const config: SellerConfig = { sellerUrl: SELLER_URL, port: 4100, payees: { search: SEARCH, scrape: SCRAPE }, payeeSource: "env", attacker: ATTACKER, contextDevKey: null, allowForceBroadcast: true };

/** SIMULATED chain: node 1 is the root; children are assigned ids as the fake relay "mines" them. */
function fakeChain() {
  const nodes = new Map<bigint, TreasuryNode>([[1n, rootNode]]);
  const byKey = new Map<string, bigint>([[keys.root.address.toLowerCase(), 1n]]);
  return {
    nodes,
    byKey,
    async readContract(a: { functionName: string; args?: readonly unknown[] }): Promise<unknown> {
      if (a.functionName === "nodeOfKey") return byKey.get(String(a.args![0]).toLowerCase()) ?? 0n;
      if (a.functionName === "getNode") return nodes.get(BigInt(a.args![0] as bigint))!;
      throw new Error(`unexpected read ${a.functionName}`);
    },
  };
}

/** SIMULATED relay: verifies nothing (the real one simulates createChild); records the signed messages. */
function fakeRelay(chain: ReturnType<typeof fakeChain>, refuse?: (c: ChildParams) => RelayAnswer | undefined): DelegationRelay & { delegated: ChildParams[]; paused: PauseChild[] } {
  const delegated: ChildParams[] = [];
  const paused: PauseChild[] = [];
  return {
    delegated,
    paused,
    async delegate(child, signature) {
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
      const refused = refuse?.(child);
      if (refused) return refused;
      delegated.push(child);
      const id = BigInt(chain.nodes.size + 1);
      chain.nodes.set(id, { key: child.key, parent: BigInt(child.parentId), depth: 1n, cap: BigInt(child.cap), spent: 0n, maxPerCall: BigInt(child.maxPerCall), expiry: BigInt(child.expiry), paused: false, restricted: child.restricted });
      chain.byKey.set(child.key.toLowerCase(), id);
      return { ok: true, transaction: TX, blockNumber: "7", childId: id.toString() };
    },
    async pauseChild(p) {
      paused.push(p);
      return { ok: true, transaction: TX, target: p.target, pausedBy: keys.root.address };
    },
  };
}

type Script = Array<Anthropic.ToolUseBlock[] | string>;
/** SIMULATED model: each sub-agent follows a script of tool calls; parse() returns a canned plan / synthesis. */
function fakeModel(scripts: Record<string, Script>): PlannerClient & { requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let seq = 0;
  const create = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    requests.push({ ...params, messages: [...params.messages] });
    const role = /You are the (\w+) sub-agent/.exec(String(params.system))?.[1] ?? "unknown";
    const script = scripts[role] ?? [];
    const step = script.shift();
    const content: Anthropic.ContentBlock[] = step === undefined ? [{ type: "text", text: "done", citations: null }] : typeof step === "string" ? [{ type: "text", text: step, citations: null }] : step;
    return { id: `msg_${++seq}`, type: "message", role: "assistant", model: "fake", stop_reason: typeof step === "object" ? "tool_use" : "end_turn", stop_sequence: null, stop_details: null, content, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Message;
  };
  const parse = async (params: { system?: unknown }) => {
    const planner = String(params.system).includes("assignment brief");
    const parsed = planner
      ? { assignments: [{ role: "research", brief: "search then propose" }, { role: "finance", brief: "price check" }, { role: "verification", brief: "sample check" }] }
      : { recommendation: "buy the national monthly dataset" };
    return { id: "msg_p", type: "message", role: "assistant", model: "fake", stop_reason: "end_turn", stop_sequence: null, stop_details: null, content: [], usage: { input_tokens: 1, output_tokens: 1 }, parsed_output: parsed };
  };
  return { requests, messages: { create, parse: parse as unknown as PlannerClient["messages"]["parse"] } };
}

const use = (id: string, name: string, input: unknown): Anthropic.ToolUseBlock => ({ type: "tool_use", id, name, input } as Anthropic.ToolUseBlock);

describe("mission runner: signed delegation, tool loops, policy refusals", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  const settled: SettleInput[] = [];
  const sellerApp = createSellerApp({
    config,
    facilitator: {
      async settle(input): Promise<SettleOutcome> {
        settled.push(input);
        // SIMULATED treasury policy: the research node may pay the search payee; the attacker is PayeeNotAllowed(2).
        if (input.payload.payload.authorization.to.toLowerCase() === ATTACKER.toLowerCase()) {
          return { outcome: "blocked", decoded: { name: "PayeeNotAllowed", args: ["2"], decoded: "PayeeNotAllowed(2)", reason: "payee not allowed for this node" }, ...(input.forceBroadcast ? { txHash: TX } : {}) };
        }
        return { outcome: "paid", txHash: TX, blockNumber: "9", nodeId: "2", payer: TREASURY, digest: `0x${"d1".repeat(32)}` as Hex };
      },
    },
  });
  const fetchImpl = async (input: string | URL, init?: RequestInit) => sellerApp.request(typeof input === "string" ? input : input.toString(), init);

  beforeAll(async () => {
    handle = await testDatabase();
    await seedCatalog(handle.db);
  });
  afterAll(() => handle.close());

  it("runs a mission: three signed CreateChild relays, every tool call logged, /api/search paid, /premium-intel refused", async () => {
    const chain = fakeChain();
    const relay = fakeRelay(chain);
    const bus = createActivityBus();
    const published: string[] = [];
    bus.subscribe((m) => m.type === "activity" && published.push(m.event.kind));
    const model = fakeModel({
      research: [
        [use("t1", "call_paid_api", { endpoint: "search", query: "EV registrations" })],
        [use("t2", "fetch_page", { url: `${SELLER_URL}${LISTING_PATH}` })],
        [use("t3", "call_paid_api", { endpoint: "premium-intel" })],
        [use("t4", "report_findings", { summary: "search paid, premium-intel refused", findings: ["policy blocked the attacker"] })],
      ],
      finance: [
        [use("f1", "list_resources", {}), use("f2", "request_sample", { resourceId: "listing-national-monthly-2024-2026", rows: 2 })],
        [use("f3", "propose_purchase", { resourceId: "listing-national-monthly-2024-2026", topic: "EV registrations", regions: ["US"], dateRange: { start: "2024-01-01", end: "2026-09-30" }, granularity: "monthly", requiredFields: ["month", "state", "units"], format: ["csv"], license: "company-use", freshness: { maxAgeDays: 90 }, maxPriceAtomic: "12000000", reason: "best coverage" })],
        [use("f4", "report_findings", { summary: "proposed the national dataset" })],
      ],
      verification: [[use("v1", "fetch_page", { url: "https://evil.example/steal" })], "nothing more to check"],
    });
    const mission = await handle.repos.missions.insert({ organizationId: "org-demo", goal: "EV market data", budgetAtomic: "5000000", rootNodeId: 1, status: "draft" });
    const runner = createMissionRunner({
      db: handle.db, bus, model: { client: model, model: "fake" }, treasury: TREASURY, chain, relay, keys,
      policies: resolveRolePolicies({ search: SEARCH, scrape: SCRAPE }, {}, ATTACKER), sellerUrl: SELLER_URL, demoMode: true, nowSeconds: () => NOW,
      fetchImpl, catalogPath: new URL("../../../../data/catalog.json", import.meta.url).pathname,
    });
    const result = await runner.run(mission);

    // Three children delegated by signature, caps split 40/40/20 of 5 USDC, restricted payees from policy.
    expect(relay.delegated.map((c) => c.cap)).toEqual(["2000000", "2000000", "1000000"]);
    expect(relay.delegated[0]!.payees).toEqual([SEARCH, SCRAPE]);
    expect(relay.delegated[1]!.payees).toEqual([]);
    expect(result.children.map((c) => c.nodeId)).toEqual([2n, 3n, 4n]);
    for (const c of result.children) expect((await handle.repos.agents.getById(c.agentId))!.nodeId).toBe(Number(c.nodeId));
    expect((await handle.repos.agents.getById("agent-orchestrator"))!.key.toLowerCase()).toBe(keys.root.address.toLowerCase());

    const events = await handle.repos.activityEvents.listByMission(mission.id);
    const kinds = (k: string) => events.filter((e) => e.kind === k);
    expect(kinds("delegation.signed")).toHaveLength(3);
    expect(kinds("delegation.relayed").every((e) => e.txHash === TX && e.agentId === "agent-orchestrator")).toBe(true);
    // Every tool call and result carries the agent id.
    const calls = kinds("agent.tool_call");
    expect(calls).toHaveLength(9);
    expect(kinds("agent.tool_result")).toHaveLength(9);
    expect(calls.every((e) => e.agentId && Object.values(ROLE_AGENT_IDS).includes(e.agentId))).toBe(true);
    // The research node paid search (seller-confirmed tx) and was refused at premium-intel with the decoded revert.
    expect(events.find((e) => e.kind === "purchase.status" && e.message.includes("/api/search"))?.txHash).toBe(TX);
    const blocked = events.find((e) => e.kind === "policy.blocked" && e.message.includes("/premium-intel"))!;
    expect(blocked.decodedRevert).toBe("PayeeNotAllowed(2)");
    expect(blocked.agentId).toBe("agent-research");
    expect(blocked.txHash).toBe(TX); // demoMode forced the broadcast
    expect(kinds("payment.authorized")).toHaveLength(2);
    // Only the research key ever signed; the authorizations name the treasury as payer.
    expect(settled.every((s) => s.payload.payload.authorization.from.toLowerCase() === TREASURY.toLowerCase())).toBe(true);
    // Parallel tool calls came back in one user message.
    const financeReq = model.requests.find((r) => String(r.system).includes("finance") && r.messages.length === 3)!;
    expect((financeReq.messages[2]!.content as unknown[]).length).toBe(2);
    // propose_purchase filed a request and paid nothing.
    expect((await handle.repos.resourceRequests.listByMission(mission.id)).map((r) => [r.agentId, r.status])).toEqual([["agent-finance", "open"]]);
    // fetch_page refused the foreign origin as an error result; the agent then ended its turn.
    expect(events.find((e) => e.kind === "agent.tool_result" && e.agentId === "agent-verification")!.message).toMatch(/ERROR.*refusing https:\/\/evil.example/);
    expect(result.agents.find((a) => a.agentId === "agent-verification")!.stop).toBe("end_turn");
    expect(result.injectionProbe).toBe("not-needed");
    expect(kinds("agent.report")).toHaveLength(3); // research, finance, orchestrator
    expect(kinds("mission.run").at(-1)!.message).toMatch(/run finished.*1 paid.*1 blocked by policy \(PayeeNotAllowed\(2\)\)/);
    expect(published).toContain("delegation.relayed");
    expect((await handle.repos.missions.getById(mission.id))!.status).toBe("active");
  });

  it("reuses a live node for a key the treasury already knows, and refuses a paused one", async () => {
    const chain = fakeChain();
    chain.nodes.set(5n, { key: keys.children.finance.address, parent: 1n, depth: 1n, cap: 1n, spent: 0n, maxPerCall: 1n, expiry: BigInt(NOW + 1000), paused: false, restricted: true });
    chain.byKey.set(keys.children.finance.address.toLowerCase(), 5n);
    const relay = fakeRelay(chain);
    const mission = await handle.repos.missions.insert({ organizationId: "org-demo", goal: "reuse", budgetAtomic: "3000000", rootNodeId: 1, status: "draft" });
    const children = await createChildren({ db: handle.db, bus: createActivityBus(), chain, relay, treasury: TREASURY, missionId: mission.id, organizationId: "org-demo", root: { account: keys.root, nodeId: 1n, node: rootNode }, children: keys.children, policies: resolveRolePolicies({ search: SEARCH, scrape: SCRAPE }), budgetAtomic: 3_000_000n, nowSeconds: () => NOW });
    expect(children.find((c) => c.role === "finance")).toMatchObject({ nodeId: 5n, txHash: null });
    expect(relay.delegated).toHaveLength(2);
    chain.nodes.get(5n)!.paused = true;
    await expect(createChildren({ db: handle.db, bus: createActivityBus(), chain, relay: fakeRelay(chain), treasury: TREASURY, missionId: mission.id, organizationId: "org-demo", root: { account: keys.root, nodeId: 1n, node: rootNode }, children: keys.children, policies: resolveRolePolicies({ search: SEARCH, scrape: SCRAPE }), budgetAtomic: 3_000_000n, nowSeconds: () => NOW })).rejects.toThrow(/paused/);
  });

  it("a refused /delegate is a policy.blocked event with the decoded revert, and the run fails loudly", async () => {
    const chain = fakeChain();
    const relay = fakeRelay(chain, (c) => (c.key.toLowerCase() === keys.children.verification.address.toLowerCase() ? { ok: false, errorReason: "ChildExceedsParent()", decoded: { name: "ChildExceedsParent", args: [] } } : undefined));
    const mission = await handle.repos.missions.insert({ organizationId: "org-demo", goal: "refused", budgetAtomic: "3000000", rootNodeId: 1, status: "draft" });
    const runner = createMissionRunner({ db: handle.db, bus: createActivityBus(), model: { client: fakeModel({}), model: "fake" }, treasury: TREASURY, chain, relay, keys, policies: resolveRolePolicies({ search: SEARCH, scrape: SCRAPE }), sellerUrl: SELLER_URL, demoMode: false, nowSeconds: () => NOW, fetchImpl });
    await expect(runner.run(mission)).rejects.toThrow(/verification: ChildExceedsParent\(\)/);
    const events = await handle.repos.activityEvents.listByMission(mission.id);
    expect(events.find((e) => e.kind === "policy.blocked")?.decodedRevert).toBe("ChildExceedsParent()");
    // Events written in the same millisecond tie-break on their random id, so "last" is not stable; the loud failure must exist.
    expect(events.some((e) => /run failed/.test(e.message))).toBe(true);
  });

  it("the orchestrator pauses a sub-agent by signature through the relay; the in-process relay maps a 409", async () => {
    const chain = fakeChain();
    const relay = fakeRelay(chain);
    const mission = await handle.repos.missions.insert({ organizationId: "org-demo", goal: "pause", budgetAtomic: "3000000", rootNodeId: 1, status: "draft" });
    await createChildren({ db: handle.db, bus: createActivityBus(), chain, relay, treasury: TREASURY, missionId: mission.id, organizationId: "org-demo", root: { account: keys.root, nodeId: 1n, node: rootNode }, children: keys.children, policies: resolveRolePolicies({ search: SEARCH, scrape: SCRAPE }), budgetAtomic: 3_000_000n, nowSeconds: () => NOW });
    const runner = createMissionRunner({ db: handle.db, bus: createActivityBus(), model: { client: fakeModel({}), model: "fake" }, treasury: TREASURY, chain, relay, keys, policies: resolveRolePolicies({ search: SEARCH, scrape: SCRAPE }), sellerUrl: SELLER_URL, demoMode: false, nowSeconds: () => NOW });
    const res = await runner.pauseAgent(mission, "agent-research");
    expect(res.txHash).toBe(TX);
    expect(relay.paused[0]!.target).toBe(String(res.nodeId));
    await expect(runner.pauseAgent(mission, "agent-orchestrator")).rejects.toThrow(/no treasury node|not one of/);

    const viaApp = relayViaApp({ request: async () => new Response(JSON.stringify({ ok: false, error: { name: "AlreadySubmitted", reason: "already relayed" } }), { status: 409 }) });
    const child = { parentId: "1", key: SEARCH, cap: "1", maxPerCall: "1", expiry: String(NOW + 10), restricted: true, payees: [], nonce: "1", deadline: String(NOW + 600) };
    expect(await viaApp.delegate(child, `0x${"11".repeat(65)}`)).toMatchObject({ ok: false, errorReason: "already relayed" });
    expect(createChildDigest(TREASURY, child)).toMatch(/^0x/);
  });
});
