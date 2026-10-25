import { z } from "zod";
import {
  AddressSchema,
  AtomicAmountSchema,
  IdSchema,
  IsoDateTimeSchema,
  UintStringSchema,
} from "./primitives";
import { DateRangeSchema, FormatSchema } from "./resource";

/**
 * draft (created) -> planning (Oracle extracted requests; the owner may edit them)
 * -> confirmed (owner confirmed; purchases may be proposed, the run may start)
 * -> active (agents running) -> complete | cancelled. Re-planning a confirmed mission
 * returns it to planning.
 */
export const MissionStatusSchema = z.enum(["draft", "planning", "confirmed", "active", "complete", "cancelled"]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

export const MissionSchema = z.object({
  id: IdSchema,
  goal: z.string().min(1),
  budgetAtomic: AtomicAmountSchema,
  /** Treasury node that pays for the mission's purchases (usually the orchestrator root). */
  rootNodeId: z.number().int().positive(),
  ownerAgentId: IdSchema.optional(),
  /** Data date range the bought data must cover; extracted requests are clamped inside it. */
  horizon: DateRangeSchema.optional(),
  /** Formats the buyer can read; extracted requests only carry these. */
  allowedFormats: z.array(FormatSchema).min(1).default([...FormatSchema.options]),
  status: MissionStatusSchema,
  createdAt: IsoDateTimeSchema,
});
export type Mission = z.infer<typeof MissionSchema>;

/** Treasury depth limit: root (0), child (1), grandchild (2). */
export const MAX_NODE_DEPTH = 2 as const;

/**
 * Mirror of the onchain `Node { key, parent, depth, cap, spent, maxPerCall, expiry, paused, restricted }`.
 * `id` is the node id (starts at 1); `parent` 0 means no parent.
 * Amounts are atomic USDC strings; `expiry` is unix seconds as a string.
 */
export const AgentNodeSchema = z.object({
  id: z.number().int().positive(),
  key: AddressSchema,
  parent: z.number().int().min(0),
  depth: z.number().int().min(0).max(MAX_NODE_DEPTH),
  cap: AtomicAmountSchema,
  spent: AtomicAmountSchema,
  maxPerCall: AtomicAmountSchema,
  expiry: UintStringSchema,
  paused: z.boolean(),
  restricted: z.boolean(),
  /** Offchain labels used by Fusion allocations and the ledger. */
  agentId: IdSchema.optional(),
  department: z.string().min(1).optional(),
});
export type AgentNode = z.infer<typeof AgentNodeSchema>;

// ---------------------------------------------------------------------------
// Treasury node views (GET /api/treasury/nodes): chain reads plus derived state
// ---------------------------------------------------------------------------

/** paused > expired > running. "paused" and "expired" include an ancestor's state, as settle() would see it. */
export const NodeStatusSchema = z.enum(["running", "paused", "expired"]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

/**
 * One treasury node as the dashboard shows it: the onchain `getNode` fields, `remaining(id)`
 * (the smallest cap - spent over the node and its ancestors), the effective status with the
 * node that causes it, the offchain agent label when a key matches, and what is known about
 * its payees. Per-node payees are a mapping onchain and cannot be enumerated: `known` lists the
 * ones that were probed and `complete` is false whenever others may exist.
 */
export const TreasuryNodeViewSchema = AgentNodeSchema.extend({
  remaining: AtomicAmountSchema,
  status: NodeStatusSchema,
  /** Nearest paused node (self or ancestor) or null. */
  pausedBy: z.number().int().positive().nullable(),
  /** Nearest expired node (self or ancestor) or null. */
  expiredBy: z.number().int().positive().nullable(),
  agent: z
    .object({ id: IdSchema, name: z.string().min(1), role: z.string().min(1), department: z.string().min(1) })
    .nullable(),
  payees: z.object({
    /** global: the treasury allowlist applies; restricted: only this node's own payees. */
    mode: z.enum(["global", "restricted"]),
    known: z.array(AddressSchema),
    complete: z.boolean(),
  }),
});
export type TreasuryNodeView = z.infer<typeof TreasuryNodeViewSchema>;

export const TreasuryNodesResponseSchema = z.object({
  treasury: AddressSchema,
  /** Head block when the nodes were read (every node is read in one pass at or after this block). */
  blockNumber: UintStringSchema,
  asOf: IsoDateTimeSchema,
  nodes: z.array(TreasuryNodeViewSchema),
  /** Replay of AllowSet events: payees currently allowed for unrestricted nodes. */
  allowlist: z.array(AddressSchema),
  /** True only for the labelled browser simulation; the service always reports false. */
  simulated: z.boolean(),
});
export type TreasuryNodesResponse = z.infer<typeof TreasuryNodesResponseSchema>;

/** One indexed `Paid(id, to, value, nonce)` log. `observedAt` is when the indexer stored it, not the block time. */
export const NodePaymentSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  logIndex: z.number().int().min(0),
  blockNumber: UintStringSchema,
  nodeId: z.number().int().positive(),
  to: AddressSchema,
  value: AtomicAmountSchema,
  nonce: z.string().min(1),
  observedAt: IsoDateTimeSchema,
  simulated: z.boolean().default(false),
});
export type NodePayment = z.infer<typeof NodePaymentSchema>;

export const NodePaymentsResponseSchema = z.object({
  nodeId: z.number().int().positive(),
  payments: z.array(NodePaymentSchema),
  simulated: z.boolean(),
});
export type NodePaymentsResponse = z.infer<typeof NodePaymentsResponseSchema>;
