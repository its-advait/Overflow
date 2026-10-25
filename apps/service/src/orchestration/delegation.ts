import { createRepositories, type Db } from "@overflow/database";
import {
  ChildParamsSchema,
  createChildDigest,
  pauseChildDigest,
  signCreateChild,
  signPauseChild,
  type ChildParams,
  type PauseChild,
} from "@overflow/payment-client";
import { overflowTreasuryAbi, Bytes32Schema, type Address } from "@overflow/schemas";
import type { PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";
import type { ActivityBus } from "../chain/bus.js";
import type { ChainClient } from "../chain/client.js";
import {
  childParamsFor,
  DELEGATION_DEADLINE_SECONDS,
  ORCHESTRATOR_AGENT_ID,
  randomUint256,
  ROLE_AGENT_IDS,
  ROLE_DEPARTMENTS,
  ROLES,
  splitBudget,
  type Role,
  type RolePolicies,
  type TreasuryNode,
} from "./delegation-plan.js";

// ---------------------------------------------------------------------------------------------------
// Gasless delegation. The orchestrator's key SIGNS CreateChild / PauseChild; the facilitator's relayer
// (POST /delegate, /pause-child) pays gas. No code here moves USDC or sends a transaction.
// ---------------------------------------------------------------------------------------------------

const DecodedSchema = z.object({ name: z.string(), args: z.array(z.string()).default([]), reason: z.string().optional() }).partial();

/** What the facilitator answers (facilitator/routes/delegations.ts), validated before anything trusts it. */
export const RelayAnswerSchema = z.object({
  ok: z.boolean(),
  transaction: Bytes32Schema.optional(),
  blockNumber: z.string().optional(),
  childId: z.string().nullable().optional(),
  target: z.string().optional(),
  pausedBy: z.string().nullable().optional(),
  errorReason: z.string().optional(),
  status: z.string().optional(),
  decoded: DecodedSchema.optional(),
  error: z.object({ name: z.string().optional(), reason: z.string().optional() }).optional(),
});
export type RelayAnswer = z.infer<typeof RelayAnswerSchema>;

export interface DelegationRelay {
  delegate(child: ChildParams, signature: `0x${string}`): Promise<RelayAnswer>;
  pauseChild(p: PauseChild, signature: `0x${string}`): Promise<RelayAnswer>;
}

export interface RelayApp {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

/** In-process relay onto the facilitator Hono app (one relayer nonce manager per process, like in-process.ts). */
export function relayViaApp(app: RelayApp): DelegationRelay {
  const post = async (path: string, body: unknown): Promise<RelayAnswer> => {
    const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    const parsed = RelayAnswerSchema.safeParse(json);
    if (!parsed.success) return { ok: false, errorReason: `facilitator answered ${res.status} with an unexpected body` };
    if (res.status === 409) return { ...parsed.data, ok: false, errorReason: parsed.data.error?.reason ?? "already relayed" };
    return parsed.data;
  };
  return {
    delegate: (child, signature) => post("/delegate", { child, signature }),
    pauseChild: (p, signature) => post("/pause-child", { ...p, signature }),
  };
}

export class DelegationFailed extends Error {
  constructor(public readonly role: Role | "pause", public readonly answer: RelayAnswer) {
    super(`${role}: ${answer.decoded?.name ? `${answer.decoded.name}(${(answer.decoded.args ?? []).join(",")})` : answer.errorReason ?? "relay refused"}`);
    this.name = "DelegationFailed";
  }
}

export type NodeReader = Pick<ChainClient, "readContract">;

export async function readNodeOfKey(chain: NodeReader, treasury: Address, key: Address): Promise<bigint> {
  return BigInt((await chain.readContract({ address: treasury, abi: overflowTreasuryAbi, functionName: "nodeOfKey", args: [key] })) as bigint | number | string);
}

export async function readNode(chain: NodeReader, treasury: Address, id: bigint): Promise<TreasuryNode> {
  const raw = (await chain.readContract({ address: treasury, abi: overflowTreasuryAbi, functionName: "getNode", args: [id] })) as unknown;
  const r = Array.isArray(raw)
    ? { key: raw[0], parent: raw[1], depth: raw[2], cap: raw[3], spent: raw[4], maxPerCall: raw[5], expiry: raw[6], paused: raw[7], restricted: raw[8] }
    : (raw as Record<string, unknown>);
  const big = (v: unknown) => BigInt(v as bigint | number | string);
  return {
    key: r["key"] as Address,
    parent: big(r["parent"]),
    depth: big(r["depth"]),
    cap: big(r["cap"]),
    spent: big(r["spent"]),
    maxPerCall: big(r["maxPerCall"]),
    expiry: big(r["expiry"]),
    paused: Boolean(r["paused"]),
    restricted: Boolean(r["restricted"]),
  };
}

export interface CreateChildrenInput {
  db: Db;
  bus: ActivityBus;
  chain: NodeReader;
  relay: DelegationRelay;
  treasury: Address;
  missionId: string;
  organizationId: string;
  root: { account: PrivateKeyAccount; nodeId: bigint; node: TreasuryNode };
  children: Record<Role, PrivateKeyAccount>;
  policies: RolePolicies;
  budgetAtomic: bigint;
  nowSeconds: () => number;
  ttlSeconds?: number;
  log?: (line: string) => void;
}

export interface ChildNode {
  role: Role;
  agentId: string;
  key: Address;
  nodeId: bigint;
  capAtomic: bigint;
  maxPerCallAtomic: bigint;
  payees: Address[];
  /** Relay transaction, or null when an existing node for this key was reused. */
  txHash: `0x${string}` | null;
}

/** Agent rows carry the real node keys (seed rows hold SIMULATED placeholders); the verification agent is added. */
export async function ensureAgentRows(db: Db, organizationId: string, root: Address, children: Record<Role, PrivateKeyAccount>): Promise<void> {
  const repos = createRepositories(db);
  const orchestrator = await repos.agents.getById(ORCHESTRATOR_AGENT_ID);
  if (orchestrator && orchestrator.key.toLowerCase() !== root.toLowerCase()) await repos.agents.setKey(ORCHESTRATOR_AGENT_ID, root);
  for (const role of ROLES) {
    const id = ROLE_AGENT_IDS[role];
    const key = children[role].address;
    const existing = await repos.agents.getById(id);
    if (!existing) {
      await repos.agents.insert({
        id,
        organizationId,
        name: `${role[0]!.toUpperCase()}${role.slice(1)} agent`,
        department: ROLE_DEPARTMENTS[role],
        role: "analyst",
        key,
        parentAgentId: ORCHESTRATOR_AGENT_ID,
      });
    } else if (existing.key.toLowerCase() !== key.toLowerCase()) {
      await repos.agents.setKey(id, key);
    }
  }
}

/**
 * One signed CreateChild per role, relayed through /delegate. A key that already owns a live node is reused
 * (the treasury would answer KeyInUse). Every step is an activity event with the orchestrator's agent id.
 */
export async function createChildren(i: CreateChildrenInput): Promise<ChildNode[]> {
  const repos = createRepositories(i.db);
  const log = i.log ?? (() => {});
  const emit = async (e: Parameters<typeof repos.activityEvents.insert>[0]) => {
    const ev = await repos.activityEvents.insert(e);
    i.bus.publish(ev);
    return ev;
  };
  await ensureAgentRows(i.db, i.organizationId, i.root.account.address, i.children);
  const shares = splitBudget(i.budgetAtomic, i.policies);
  const out: ChildNode[] = [];
  for (const role of ROLES) {
    const agentId = ROLE_AGENT_IDS[role];
    const key = i.children[role].address;
    const existingId = await readNodeOfKey(i.chain, i.treasury, key);
    if (existingId !== 0n) {
      const node = await readNode(i.chain, i.treasury, existingId);
      const now = BigInt(i.nowSeconds());
      if (node.paused || node.expiry <= now) {
        throw new Error(`${role} key ${key} already owns node ${existingId}, which is ${node.paused ? "paused" : "expired"}; supply a fresh key in AGENT_KEYS`);
      }
      await repos.agents.setNodeId(agentId, Number(existingId));
      await emit({ kind: "delegation.relayed", missionId: i.missionId, agentId: ORCHESTRATOR_AGENT_ID, message: `${role}: reused existing node ${existingId} for key ${key} (cap ${node.cap}, spent ${node.spent}, maxPerCall ${node.maxPerCall})` });
      log(`[delegation] ${role}: reused node ${existingId}`);
      out.push({ role, agentId, key, nodeId: existingId, capAtomic: node.cap, maxPerCallAtomic: node.maxPerCall, payees: i.policies[role].payees, txHash: null });
      continue;
    }
    const child = ChildParamsSchema.parse(
      childParamsFor({ parentNodeId: i.root.nodeId, key, share: shares[role], policy: i.policies[role], root: i.root.node, nowSeconds: i.nowSeconds(), ...(i.ttlSeconds !== undefined ? { ttlSeconds: i.ttlSeconds } : {}) }),
    );
    const signature = await signCreateChild(i.root.account, i.treasury, child);
    const digest = createChildDigest(i.treasury, child);
    await emit({ kind: "delegation.signed", missionId: i.missionId, agentId: ORCHESTRATOR_AGENT_ID, message: `${role}: orchestrator signed CreateChild for ${key} (cap ${child.cap}, maxPerCall ${child.maxPerCall}, expiry ${child.expiry}, payees ${child.payees.length}) digest ${digest}` });
    const answer = await i.relay.delegate(child, signature);
    if (!answer.ok || !answer.transaction) {
      const decoded = answer.decoded?.name ? `${answer.decoded.name}(${(answer.decoded.args ?? []).join(",")})` : undefined;
      await emit({ kind: "policy.blocked", missionId: i.missionId, agentId: ORCHESTRATOR_AGENT_ID, message: `${role}: /delegate refused CreateChild: ${decoded ?? answer.errorReason ?? "unknown"}`, ...(decoded ? { decodedRevert: decoded } : {}), ...(answer.transaction ? { txHash: answer.transaction } : {}) });
      throw new DelegationFailed(role, answer);
    }
    const nodeId = answer.childId ? BigInt(answer.childId) : await readNodeOfKey(i.chain, i.treasury, key);
    await repos.agents.setNodeId(agentId, Number(nodeId));
    await emit({ kind: "delegation.relayed", missionId: i.missionId, agentId: ORCHESTRATOR_AGENT_ID, message: `${role}: NodeCreated id ${nodeId} parent ${i.root.nodeId} key ${key} (relayed gaslessly; block ${answer.blockNumber ?? "?"})`, txHash: answer.transaction });
    log(`[delegation] ${role}: node ${nodeId} tx ${answer.transaction}`);
    out.push({ role, agentId, key, nodeId, capAtomic: BigInt(child.cap), maxPerCallAtomic: BigInt(child.maxPerCall), payees: child.payees, txHash: answer.transaction });
  }
  return out;
}

export interface PauseDescendantInput {
  db: Db;
  bus: ActivityBus;
  relay: DelegationRelay;
  treasury: Address;
  signer: PrivateKeyAccount;
  targetNodeId: bigint;
  missionId?: string;
  targetAgentId?: string;
  nowSeconds: () => number;
}

/** The orchestrator (any strict ancestor) signs PauseChild; the relay pays gas. The controller's owner pause is separate. */
export async function pauseDescendant(i: PauseDescendantInput): Promise<{ txHash: `0x${string}`; digest: `0x${string}` }> {
  const repos = createRepositories(i.db);
  const p: PauseChild = { target: i.targetNodeId.toString(), nonce: randomUint256(), deadline: (i.nowSeconds() + DELEGATION_DEADLINE_SECONDS).toString() };
  const signature = await signPauseChild(i.signer, i.treasury, p);
  const digest = pauseChildDigest(i.treasury, p);
  const base = { ...(i.missionId ? { missionId: i.missionId } : {}), agentId: ORCHESTRATOR_AGENT_ID };
  const signed = await repos.activityEvents.insert({ kind: "delegation.signed", ...base, message: `orchestrator signed PauseChild for node ${i.targetNodeId}${i.targetAgentId ? ` (${i.targetAgentId})` : ""} digest ${digest}` });
  i.bus.publish(signed);
  const answer = await i.relay.pauseChild(p, signature);
  if (!answer.ok || !answer.transaction) {
    const decoded = answer.decoded?.name ? `${answer.decoded.name}(${(answer.decoded.args ?? []).join(",")})` : undefined;
    const ev = await repos.activityEvents.insert({ kind: "policy.blocked", ...base, message: `/pause-child refused: ${decoded ?? answer.errorReason ?? "unknown"}`, ...(decoded ? { decodedRevert: decoded } : {}) });
    i.bus.publish(ev);
    throw new DelegationFailed("pause", answer);
  }
  const ev = await repos.activityEvents.insert({ kind: "delegation.relayed", ...base, message: `NodePaused ${i.targetNodeId} by orchestrator (relayed gaslessly)`, txHash: answer.transaction });
  i.bus.publish(ev);
  return { txHash: answer.transaction, digest };
}
