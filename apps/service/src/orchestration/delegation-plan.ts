import { AddressSchema, type Address, type ChildParams } from "./deps-types.js";
import { toHex } from "viem";
import { randomBytes } from "node:crypto";

/** The three sub-agents an orchestrator delegates to. Order matters: AGENT_KEYS maps onto it. */
export const ROLES = ["research", "finance", "verification"] as const;
export type Role = (typeof ROLES)[number];

/** Seeded agent rows (packages/database/src/seed.ts) plus the verification agent this module adds. */
export const ROLE_AGENT_IDS: Record<Role, string> = {
  research: "agent-research",
  finance: "agent-finance",
  verification: "agent-verification",
};
export const ORCHESTRATOR_AGENT_ID = "agent-orchestrator";

export const ROLE_DEPARTMENTS: Record<Role, string> = { research: "research", finance: "finance", verification: "research" };

/** What one role's child node may do: its spending share, per-call limit and the payees it may ever pay. */
export interface RolePolicy {
  bps: number;
  maxPerCallAtomic: bigint;
  payees: Address[];
}
export type RolePolicies = Record<Role, RolePolicy>;

export interface SellerPayees {
  search: Address;
  scrape: Address;
}

/**
 * Defaults: research pays the search and scrape APIs, finance proposes only (no payees), verification may
 * re-run searches. Overrides: ORCHESTRATION_PAYEES_<ROLE>=addr,addr and ORCHESTRATION_BPS_<ROLE>.
 * The attacker payee is refused here as well as on chain.
 */
export function resolveRolePolicies(payees: SellerPayees, env: NodeJS.ProcessEnv = process.env, attacker: Address | null = null): RolePolicies {
  const defaults: RolePolicies = {
    research: { bps: 4000, maxPerCallAtomic: 1_000_000n, payees: [payees.search, payees.scrape] },
    finance: { bps: 4000, maxPerCallAtomic: 15_000_000n, payees: [] },
    verification: { bps: 2000, maxPerCallAtomic: 500_000n, payees: [payees.search] },
  };
  for (const role of ROLES) {
    const list = env[`ORCHESTRATION_PAYEES_${role.toUpperCase()}`]?.trim();
    if (list !== undefined && list !== "") {
      defaults[role].payees = list.split(",").map((a) => AddressSchema.parse(a.trim()));
    }
    const bps = env[`ORCHESTRATION_BPS_${role.toUpperCase()}`]?.trim();
    if (bps) defaults[role].bps = Number.parseInt(bps, 10);
    if (attacker && defaults[role].payees.some((p) => p.toLowerCase() === attacker.toLowerCase())) {
      throw new Error(`role ${role} lists the SIMULATED attacker ${attacker} as a payee; refusing`);
    }
  }
  const total = ROLES.reduce((s, r) => s + defaults[r].bps, 0);
  if (total > 10_000 || ROLES.some((r) => !Number.isInteger(defaults[r].bps) || defaults[r].bps < 0)) {
    throw new Error(`role budget shares must be non-negative integers summing to at most 10000 bps (got ${total})`);
  }
  return defaults;
}

/** Integer basis-point split; whatever rounding leaves over stays with the orchestrator. */
export function splitBudget(budgetAtomic: bigint, policies: RolePolicies): Record<Role, bigint> {
  if (budgetAtomic <= 0n) throw new Error("mission budget must be positive");
  const out = {} as Record<Role, bigint>;
  let assigned = 0n;
  for (const role of ROLES) {
    out[role] = (budgetAtomic * BigInt(policies[role].bps)) / 10_000n;
    assigned += out[role];
  }
  if (assigned > budgetAtomic) throw new Error("budget split exceeds the mission budget");
  return out;
}

/** Onchain Node, as getNode() returns it. */
export interface TreasuryNode {
  key: Address;
  parent: bigint;
  depth: bigint;
  cap: bigint;
  spent: bigint;
  maxPerCall: bigint;
  expiry: bigint;
  paused: boolean;
  restricted: boolean;
}

export const DEFAULT_CHILD_TTL_SECONDS = 86_400;
export const DELEGATION_DEADLINE_SECONDS = 600;

export function randomUint256(): string {
  return BigInt(toHex(randomBytes(32))).toString();
}

export interface ChildParamsInput {
  parentNodeId: bigint;
  key: Address;
  share: bigint;
  policy: RolePolicy;
  root: TreasuryNode;
  nowSeconds: number;
  ttlSeconds?: number;
  nonce?: string;
}

/** The CreateChild message for one role, every limit clamped inside the parent's (the treasury rejects more). */
export function childParamsFor(i: ChildParamsInput): ChildParams {
  const now = BigInt(i.nowSeconds);
  if (i.root.paused) throw new Error(`root node ${i.parentNodeId} is paused`);
  if (i.root.expiry <= now) throw new Error(`root node ${i.parentNodeId} expired at ${i.root.expiry}`);
  if (i.share <= 0n) throw new Error("child share must be positive");
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  const cap = min(i.share, i.root.cap);
  const maxPerCall = min(i.policy.maxPerCallAtomic, min(i.root.maxPerCall, cap));
  const expiry = min(now + BigInt(i.ttlSeconds ?? DEFAULT_CHILD_TTL_SECONDS), i.root.expiry - 60n);
  if (expiry <= now) throw new Error("root node expires too soon to delegate");
  return {
    parentId: i.parentNodeId.toString(),
    key: i.key,
    cap: cap.toString(),
    maxPerCall: maxPerCall.toString(),
    expiry: expiry.toString(),
    restricted: true,
    payees: i.policy.payees,
    nonce: i.nonce ?? randomUint256(),
    deadline: (now + BigInt(DELEGATION_DEADLINE_SECONDS)).toString(),
  };
}
