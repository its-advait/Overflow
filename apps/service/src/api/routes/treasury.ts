import {
  AddressSchema,
  AtomicAmountSchema,
  atomicToBigInt,
  EscrowStatusSchema,
  IdSchema,
  IsoDateTimeSchema,
  NodePaymentsResponseSchema,
  TreasuryNodesResponseSchema,
  UintStringSchema,
  type Address,
  type AgentRecord,
  type ChainTransaction,
  type EscrowOrder,
  type NodePayment,
  type NodeStatus,
  type TreasuryNodeView,
} from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { TreasuryNode } from "../../orchestration/delegation-plan.js";
import type { ApiDeps } from "../deps.js";
import { ApiError, parseParams, respond, type ApiEnv } from "../http.js";
import { NotWiredError } from "../ports.js";

// ---------------------------------------------------------------------------
// GET /api/treasury                    the overview's money cards: USDC balanceOf(treasury) and reservedTotal()
//                                      read at one block, beside the USDC the open escrows hold (escrow_orders).
// GET /api/treasury/nodes              the delegation tree as the chain holds it (getNode, remaining, allowlist).
// GET /api/treasury/nodes/:id/payments indexed Paid logs signed by one node.
//
// Every number comes from a view call made in this request or from an indexed log; nothing is cached or inferred
// from local flags. When no chain reader is wired the chain part is null with the reason (or 501), never a stale
// or invented number.
// ---------------------------------------------------------------------------

const ChainSnapshotSchema = z.object({
  blockNumber: UintStringSchema,
  /** USDC.balanceOf(treasury). */
  balanceAtomic: AtomicAmountSchema,
  /** OverflowTreasury.reservedTotal(): promised to open reservations; the floor check counts it. */
  reservedTotalAtomic: AtomicAmountSchema,
  usdc: AddressSchema,
  readAt: IsoDateTimeSchema,
});

const OpenEscrowSchema = z.object({
  purchaseId: IdSchema,
  escrowAddress: AddressSchema,
  status: EscrowStatusSchema,
  amountAtomic: AtomicAmountSchema,
  /** True once OrderFunded was indexed (Funded or Revealed): the USDC sits in the escrow contract. */
  funded: z.boolean(),
});

export const TreasuryResponse = z.object({
  treasury: AddressSchema.nullable(),
  chain: ChainSnapshotSchema.nullable(),
  /** Why `chain` is null (no RPC / deployments). Absent when `chain` is set. */
  chainUnavailable: z.string().optional(),
  escrow: z.object({
    /** Orders not yet Settled or Refunded, including Created ones that hold no USDC yet. */
    openOrders: z.number().int().min(0),
    /** Open orders the chain has funded (Funded, Revealed). */
    fundedOrders: z.number().int().min(0),
    /** Σ amount over funded open orders: USDC held by escrow contracts for this treasury, bonds excluded. */
    committedAtomic: AtomicAmountSchema,
    orders: z.array(OpenEscrowSchema),
  }),
});
export type TreasuryResponseBody = z.infer<typeof TreasuryResponse>;

/** Funded and Revealed orders hold the buyer's USDC; a Created order exists onchain but nothing has moved. */
export const holdsFunds = (o: Pick<EscrowOrder, "status">): boolean => o.status === "Funded" || o.status === "Revealed";

const IdParams = z.object({ id: z.coerce.number().int().positive() });

export interface ReadNode extends TreasuryNode {
  id: number;
  remaining: bigint;
}

interface Derived {
  status: NodeStatus;
  pausedBy: number | null;
  expiredBy: number | null;
}

/** Walks self then ancestors: the nearest paused / expired node wins, paused before expired (settle() checks paused first). */
export function deriveStatus(nodes: ReadonlyMap<number, ReadNode>, id: number, nowSeconds: bigint): Derived {
  let pausedBy: number | null = null;
  let expiredBy: number | null = null;
  let cursor: number | undefined = id;
  const seen = new Set<number>();
  while (cursor !== undefined && cursor !== 0 && !seen.has(cursor)) {
    seen.add(cursor);
    const n = nodes.get(cursor);
    if (!n) break;
    if (pausedBy === null && n.paused) pausedBy = cursor;
    if (expiredBy === null && n.expiry <= nowSeconds) expiredBy = cursor;
    cursor = Number(n.parent);
  }
  return { status: pausedBy !== null ? "paused" : expiredBy !== null ? "expired" : "running", pausedBy, expiredBy };
}

/** AllowSet replay in chain order: the last write per payee wins. */
export function replayAllowlist(rows: readonly ChainTransaction[]): Address[] {
  const state = new Map<string, { address: Address; allowed: boolean }>();
  for (const r of rows) {
    const payee = String(r.args["payee"] ?? "");
    if (!payee.startsWith("0x")) continue;
    const v = r.args["allowed"];
    const allowed = v === true || v === "true";
    state.set(payee.toLowerCase(), { address: payee as Address, allowed });
  }
  return [...state.values()].filter((s) => s.allowed).map((s) => s.address);
}

export function paidToPayment(row: ChainTransaction): NodePayment | null {
  const id = Number(row.args["id"]);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    txHash: row.txHash,
    logIndex: row.logIndex,
    blockNumber: row.blockNumber,
    nodeId: id,
    to: String(row.args["to"]) as Address,
    value: String(row.args["value"]),
    nonce: String(row.args["nonce"] ?? ""),
    observedAt: row.observedAt,
    simulated: false,
  };
}

export function treasuryRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();

  app.get("/", async (c) => {
    const open = await deps.repos.escrowOrders.listOpen();
    const funded = open.filter(holdsFunds);
    const committed = funded.reduce((sum, o) => sum + atomicToBigInt(o.amountAtomic), 0n);

    let chain: z.input<typeof ChainSnapshotSchema> | null = null;
    let chainUnavailable: string | undefined;
    try {
      const snapshot = await deps.ports.treasury.read();
      chain = {
        blockNumber: snapshot.blockNumber,
        balanceAtomic: snapshot.balanceAtomic,
        reservedTotalAtomic: snapshot.reservedTotalAtomic,
        usdc: snapshot.usdc,
        readAt: snapshot.readAt,
      };
    } catch (e) {
      if (!(e instanceof NotWiredError)) throw e;
      chainUnavailable = e.message;
    }

    return respond(c, TreasuryResponse, {
      treasury: deps.treasury,
      chain,
      ...(chainUnavailable !== undefined ? { chainUnavailable } : {}),
      escrow: {
        openOrders: open.length,
        fundedOrders: funded.length,
        committedAtomic: committed.toString(),
        orders: open.map((o) => ({
          purchaseId: o.purchaseId,
          escrowAddress: o.escrowAddress,
          status: o.status,
          amountAtomic: o.amountAtomic,
          funded: holdsFunds(o),
        })),
      },
    });
  });

  app.get("/nodes", async (c) => {
    const treasury = deps.exceptions.treasury;
    if (!treasury) throw new ApiError(501, "not_wired", "no treasury in deployments/base-sepolia.json; node state is never invented");
    const read = deps.ports.treasuryRead;
    const [blockNumber, count] = await Promise.all([read.blockNumber(), read.nodeCount()]);
    const ids = Array.from({ length: Number(count) }, (_, i) => i + 1);
    const nodes = new Map<number, ReadNode>();
    await Promise.all(
      ids.map(async (id) => {
        const [node, remaining] = await Promise.all([read.getNode(BigInt(id)), read.remaining(BigInt(id))]);
        nodes.set(id, { ...node, id, remaining });
      }),
    );

    const agents = await deps.repos.agents.listByOrganization(c.get("session").organizationId);
    const byNodeId = new Map<number, AgentRecord>();
    const byKey = new Map<string, AgentRecord>();
    for (const a of agents) {
      if (a.nodeId) byNodeId.set(a.nodeId, a);
      byKey.set(a.key.toLowerCase(), a);
    }

    const allowlist = replayAllowlist(await deps.repos.chainTransactions.listByEvent("AllowSet"));
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

    const views: TreasuryNodeView[] = await Promise.all(
      ids.map(async (id) => {
        const n = nodes.get(id)!;
        const agent = byNodeId.get(id) ?? byKey.get(n.key.toLowerCase());
        const derived = deriveStatus(nodes, id, nowSeconds);
        let payees: TreasuryNodeView["payees"];
        if (n.restricted) {
          // Per-node payees are a mapping: probe the ones we know about and say the list may be incomplete.
          const probes = await Promise.all(allowlist.map(async (p) => ((await read.nodeAllow(BigInt(id), p)) ? p : null)));
          payees = { mode: "restricted", known: probes.filter((p): p is Address => p !== null), complete: false };
        } else {
          payees = { mode: "global", known: allowlist, complete: true };
        }
        return {
          id,
          key: n.key,
          parent: Number(n.parent),
          depth: Number(n.depth),
          cap: n.cap.toString(),
          spent: n.spent.toString(),
          maxPerCall: n.maxPerCall.toString(),
          expiry: n.expiry.toString(),
          paused: n.paused,
          restricted: n.restricted,
          ...(agent ? { agentId: agent.id, department: agent.department } : {}),
          remaining: n.remaining.toString(),
          ...derived,
          agent: agent ? { id: agent.id, name: agent.name, role: agent.role, department: agent.department } : null,
          payees,
        };
      }),
    );

    return respond(c, TreasuryNodesResponseSchema, {
      treasury,
      blockNumber: blockNumber.toString(),
      asOf: new Date().toISOString(),
      nodes: views,
      allowlist,
      simulated: false,
    });
  });

  /** Indexed Paid logs where args.id is this node (the signer), newest block first. */
  app.get("/nodes/:id/payments", async (c) => {
    const { id } = parseParams(c, IdParams);
    const rows = await deps.repos.chainTransactions.listByEvent("Paid");
    const payments = rows
      .map(paidToPayment)
      .filter((p): p is NodePayment => p !== null && p.nodeId === id)
      .reverse();
    return respond(c, NodePaymentsResponseSchema, { nodeId: id, payments, simulated: false });
  });

  return app;
}
