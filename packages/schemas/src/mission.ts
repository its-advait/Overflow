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
