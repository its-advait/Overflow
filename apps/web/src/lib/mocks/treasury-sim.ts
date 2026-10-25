import {
  ActivityEventSchema,
  ControllerRequestSchema,
  ExceptionRecordSchema,
  formatUsdc,
  type ActivityEvent,
  type Address,
  type ControllerRequest,
  type ExceptionRecord,
  type Hex,
  type NodePayment,
  type NodePaymentsResponse,
  type TreasuryNodesResponse,
  type TreasuryNodeView,
} from "@overflow/schemas";
import { ApiError } from "../api/client";
import type { RaiseExceptionBody, RaiseExceptionResponse } from "../api/contracts";
import { ancestorsOf, deriveStatus, remainingOf } from "../tree";
import { agents, MOCK_LABEL, TREASURY_ADDRESS } from "./fixtures";

// ---------------------------------------------------------------------------
// SIMULATED treasury for the mock client. A browser-local model of the
// delegation tree that behaves like OverflowTreasury's _authorize walk: a
// child's payment charges every ancestor, a paused or expired ancestor refuses
// the whole subtree, caps and per-call limits revert with the binding node's
// id. Controller requests are approved by a SIMULATED owner after a delay and
// only then does state change. Every event, payment and request carries
// simulated: true; nothing here is a chain, a signature or a service response.
// ---------------------------------------------------------------------------

export const SIM_LABEL = `${MOCK_LABEL} SIMULATED` as const;
export const SIM_TICK_MS = 3_000;
export const SIM_APPROVAL_MS = 4_000;
const SIM_BLOCK_START = 49_900_000;

const simAddr = (tag: string): Address => `0x${tag.toLowerCase().padEnd(40, "0")}` as Address;
/** Obviously fake 32-byte hash: "51a0" (sim) then a counter. Never a real transaction. */
const simTx = (n: number): Hex => `0x51a0${n.toString(16).padStart(60, "0")}` as Hex;

/** SIMULATED sellers (allowlisted), the scraper's own payee and a SIMULATED attacker (never allowlisted). */
export const SIM_PAYEES = {
  search: simAddr("5e11e201"),
  index: simAddr("5e11e202"),
  scrape: simAddr("5e11e203"),
  attacker: simAddr("a77ac4e2"),
} as const;

export interface SimNode {
  id: number;
  key: Address;
  parent: number;
  depth: number;
  cap: bigint;
  spent: bigint;
  maxPerCall: bigint;
  expiry: bigint;
  paused: boolean;
  restricted: boolean;
  agentId: string | null;
  /** Lowercase payees of a restricted node (set at creation, as in createChild). */
  payees: Set<string>;
}

export interface SimOptions {
  now?: () => number;
  tickMs?: number;
  approvalMs?: number;
}

const USDC = (whole: number, cents = 0): bigint => BigInt(whole) * 1_000_000n + BigInt(cents) * 10_000n;

function initialNodes(nowSeconds: number): Map<number, SimNode> {
  const expiry = BigInt(nowSeconds + 7 * 86_400);
  const mk = (n: Omit<SimNode, "expiry" | "payees" | "restricted"> & { restricted?: boolean; payees?: Address[] }): SimNode => ({
    ...n,
    expiry,
    restricted: n.restricted ?? false,
    payees: new Set((n.payees ?? []).map((p) => p.toLowerCase())),
  });
  const key = (agentId: string): Address => agents.find((a) => a.id === agentId)?.key ?? simAddr("dead");
  // Spent amounts are consistent with the ancestor walk: root 7.50 = finance 3.00 + research 4.50.
  return new Map<number, SimNode>([
    [1, mk({ id: 1, key: key("agent-orchestrator"), parent: 0, depth: 0, cap: USDC(100), spent: USDC(7, 50), maxPerCall: USDC(15), paused: false, agentId: "agent-orchestrator" })],
    [2, mk({ id: 2, key: key("agent-finance"), parent: 1, depth: 1, cap: USDC(25), spent: USDC(3), maxPerCall: USDC(5), paused: false, agentId: "agent-finance" })],
    [3, mk({ id: 3, key: key("agent-research"), parent: 1, depth: 1, cap: USDC(25), spent: USDC(4, 50), maxPerCall: USDC(5), paused: false, agentId: "agent-research" })],
    [4, mk({ id: 4, key: key("agent-research-scraper"), parent: 3, depth: 2, cap: USDC(10), spent: USDC(2, 50), maxPerCall: USDC(2), paused: false, agentId: "agent-research-scraper", restricted: true, payees: [SIM_PAYEES.scrape] })],
    [5, mk({ id: 5, key: key("agent-finance-ledger"), parent: 2, depth: 2, cap: USDC(10), spent: USDC(2), maxPerCall: USDC(2), paused: false, agentId: "agent-finance-ledger" })],
  ]);
}

/** Deterministic script of payment attempts; tick 6 of every 7 tries the attacker, tick 10 of every 11 overshoots per-call. */
const ATTEMPTS: ReadonlyArray<{ node: number; payee: Address }> = [
  { node: 4, payee: SIM_PAYEES.scrape },
  { node: 5, payee: SIM_PAYEES.search },
  { node: 4, payee: SIM_PAYEES.scrape },
  { node: 5, payee: SIM_PAYEES.index },
  { node: 2, payee: SIM_PAYEES.index },
  { node: 3, payee: SIM_PAYEES.search },
];
const AMOUNTS: readonly bigint[] = [USDC(0, 50), USDC(0, 90), USDC(1, 30), USDC(2)];

export class TreasurySim {
  readonly nodes: Map<number, SimNode>;
  readonly allowlist = new Set<string>([SIM_PAYEES.search.toLowerCase(), SIM_PAYEES.index.toLowerCase()]);
  readonly payments: NodePayment[] = [];
  readonly requests: ControllerRequest[] = [];
  readonly exceptions: ExceptionRecord[] = [];
  readonly events: ActivityEvent[] = [];
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly approvalMs: number;
  private listeners = new Set<(e: ActivityEvent) => void>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private pending = new Set<ReturnType<typeof setTimeout>>();
  private seq = 0;
  private ticks = 0;
  private block = SIM_BLOCK_START;

  constructor(opts: SimOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.tickMs = opts.tickMs ?? SIM_TICK_MS;
    this.approvalMs = opts.approvalMs ?? SIM_APPROVAL_MS;
    this.nodes = initialNodes(Math.floor(this.now() / 1000));
  }

  // -- reads -----------------------------------------------------------------

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }

  snapshot(): TreasuryNodesResponse {
    const nowSec = this.nowSeconds();
    const allowlist = [...this.allowlist] as Address[];
    const nodes: TreasuryNodeView[] = [...this.nodes.values()]
      .sort((a, b) => a.id - b.id)
      .map((n) => {
        const agent = n.agentId ? agents.find((a) => a.id === n.agentId) : undefined;
        return {
          id: n.id,
          key: n.key,
          parent: n.parent,
          depth: n.depth,
          cap: n.cap.toString(),
          spent: n.spent.toString(),
          maxPerCall: n.maxPerCall.toString(),
          expiry: n.expiry.toString(),
          paused: n.paused,
          restricted: n.restricted,
          ...(agent ? { agentId: agent.id, department: agent.department } : {}),
          remaining: remainingOf(this.nodes, n.id).toString(),
          ...deriveStatus(this.nodes, n.id, nowSec),
          agent: agent ? { id: agent.id, name: agent.name, role: agent.role, department: agent.department } : null,
          payees: n.restricted
            ? { mode: "restricted" as const, known: [...n.payees] as Address[], complete: true }
            : { mode: "global" as const, known: allowlist, complete: true },
        };
      });
    return { treasury: TREASURY_ADDRESS, blockNumber: String(this.block), asOf: this.at(), nodes, allowlist, simulated: true };
  }

  paymentsOf(nodeId: number): NodePaymentsResponse {
    return { nodeId, payments: [...this.payments].filter((p) => p.nodeId === nodeId).reverse(), simulated: true };
  }

  request(id: string): ControllerRequest | undefined {
    return this.requests.find((r) => r.id === id);
  }

  // -- the authorize walk ------------------------------------------------------

  /** Mirrors OverflowTreasury._authorize: self first, then ancestors; the first failing check names the binding node. */
  authorize(nodeId: number, payee: Address, value: bigint): { ok: true } | { ok: false; decodedRevert: string } {
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, decodedRevert: "UnknownAgent()" };
    const walk = ancestorsOf(this.nodes, nodeId);
    const nowSec = BigInt(this.nowSeconds());
    for (const n of walk) if (n.paused) return { ok: false, decodedRevert: `Paused(${n.id})` };
    for (const n of walk) if (n.expiry <= nowSec) return { ok: false, decodedRevert: `Expired(${n.id})` };
    const allowed = node.restricted ? node.payees.has(payee.toLowerCase()) : this.allowlist.has(payee.toLowerCase());
    if (!allowed) return { ok: false, decodedRevert: `PayeeNotAllowed(${node.id})` };
    for (const n of walk) if (value > n.maxPerCall) return { ok: false, decodedRevert: `OverPerCall(${n.id})` };
    for (const n of walk) if (n.spent + value > n.cap) return { ok: false, decodedRevert: `OverBudget(${n.id})` };
    return { ok: true };
  }

  /** One SIMULATED payment attempt. On success every ancestor's spent grows (settle()'s walk); on refusal nothing moves. */
  pay(nodeId: number, payee: Address, value: bigint): ActivityEvent {
    const node = this.nodes.get(nodeId);
    const label = node?.agentId ? agents.find((a) => a.id === node.agentId)?.name ?? `node ${nodeId}` : `node ${nodeId}`;
    const verdict = this.authorize(nodeId, payee, value);
    if (!verdict.ok) {
      return this.emit({
        kind: "policy.blocked",
        message: `Treasury refused node ${nodeId} (${label}) paying ${formatUsdc(value)} USDC to ${payee}: ${verdict.decodedRevert} [${SIM_LABEL}]`,
        ...(node?.agentId ? { agentId: node.agentId } : {}),
        decodedRevert: verdict.decodedRevert,
      });
    }
    for (const n of ancestorsOf(this.nodes, nodeId)) n.spent += value;
    this.block += 1;
    const txHash = simTx(++this.seq);
    this.payments.push({
      txHash,
      logIndex: 0,
      blockNumber: String(this.block),
      nodeId,
      to: payee,
      value: value.toString(),
      nonce: simTx(0x7000 + this.seq),
      observedAt: this.at(),
      simulated: true,
    });
    return this.emit({
      kind: "treasury.paid",
      message: `Paid(${nodeId}): ${formatUsdc(value)} USDC to ${payee} signed by ${label}; every ancestor charged [${SIM_LABEL}]`,
      ...(node?.agentId ? { agentId: node.agentId } : {}),
      txHash,
    });
  }

  /** The scripted ticker: one attempt per tick. */
  tick(): ActivityEvent {
    const t = this.ticks++;
    const attempt = ATTEMPTS[t % ATTEMPTS.length]!;
    if (t % 7 === 6) return this.pay(attempt.node, SIM_PAYEES.attacker, AMOUNTS[0]!);
    if (t % 11 === 10) return this.pay(5, SIM_PAYEES.search, USDC(3));
    return this.pay(attempt.node, attempt.payee, AMOUNTS[t % AMOUNTS.length]!);
  }

  // -- controller requests -----------------------------------------------------

  /**
   * Opens an exception with a prepared owner call, exactly one open per subject. Nothing changes
   * until the SIMULATED owner approves after `approvalMs`; the response is PENDING either way.
   */
  raise(body: RaiseExceptionBody): RaiseExceptionResponse {
    const subject =
      body.type === "PAUSE_REQUEST" ? `node:${body.nodeId}:pause` : body.type === "CAP_RAISE" ? `node:${body.nodeId}:cap` : `payee:${body.payee.toLowerCase()}`;
    if (body.type !== "NEW_PAYEE" && !this.nodes.has(body.nodeId)) {
      throw new ApiError(404, "not_found", `node ${body.nodeId} does not exist (${SIM_LABEL})`);
    }
    const open = this.exceptions.find((e) => e.subject === subject && e.status === "open");
    if (open) {
      const request = this.requests.find((r) => r.exceptionId === open.id) ?? null;
      return { exception: open, request, created: false };
    }
    const n = ++this.seq;
    const at = this.at();
    const action: ControllerRequest["action"] =
      body.type === "PAUSE_REQUEST"
        ? { kind: "pause", nodeId: body.nodeId }
        : body.type === "CAP_RAISE"
          ? { kind: "raise-cap", nodeId: body.nodeId, newCapAtomic: body.newCapAtomic }
          : { kind: "set-allow", payee: body.payee, allowed: true };
    const summary =
      action.kind === "pause"
        ? `pause(${action.nodeId}): node ${action.nodeId} and its subtree can no longer authorize payments until unpaused.`
        : action.kind === "raise-cap"
          ? `raiseCap(${action.nodeId}, ${action.newCapAtomic}): cap becomes ${formatUsdc(action.newCapAtomic)} USDC.`
          : `setAllow(${action.payee}, true): payee allowed for every unrestricted node (treasury allowlist).`;
    const details: Record<string, unknown> =
      body.type === "NEW_PAYEE" ? { payee: body.payee } : body.type === "CAP_RAISE" ? { nodeId: body.nodeId, newCapAtomic: body.newCapAtomic } : { nodeId: body.nodeId };
    if (body.agentId) details["agentId"] = body.agentId;
    const exception = ExceptionRecordSchema.parse({
      id: `exc-sim-${n}`,
      type: body.type,
      reason: body.reason,
      status: "open",
      openedAt: at,
      subject,
      requestedBy: body.requestedBy,
      details,
    });
    const request = ControllerRequestSchema.parse({
      id: `cr-sim-${n}`,
      action,
      exceptionId: exception.id,
      requestedBy: body.requestedBy,
      reason: body.reason,
      target: TREASURY_ADDRESS,
      // SIMULATED calldata: a selector-shaped prefix and the sequence number. Not a real encoding.
      data: `0x5e11${n.toString(16).padStart(60, "0")}`,
      value: "0",
      summary: `${summary} [${SIM_LABEL}]`,
      status: "pending",
      createdAt: at,
    });
    this.exceptions.push(exception);
    this.requests.push(request);
    this.emit({
      kind: "controller.requested",
      message: `Prepared ${summary} Awaiting the SIMULATED owner; nothing changed [${SIM_LABEL}]`,
      ...(body.agentId ? { agentId: body.agentId } : {}),
    });
    const timer = setTimeout(() => {
      this.pending.delete(timer);
      this.approve(request.id);
    }, this.approvalMs);
    this.pending.add(timer);
    return { exception, request, created: true };
  }

  /** The SIMULATED owner's transaction confirms: state changes, the event fires, and only now is the request done. */
  approve(requestId: string): void {
    const idx = this.requests.findIndex((r) => r.id === requestId);
    const request = this.requests[idx];
    if (!request || request.status !== "pending") return;
    const a = request.action;
    this.block += 1;
    const txHash = simTx(++this.seq);
    let eventName: string;
    if (a.kind === "pause") {
      const node = this.nodes.get(a.nodeId);
      if (node) node.paused = true;
      eventName = `NodePaused(${a.nodeId}, owner)`;
      this.emit({ kind: "treasury.node", message: `${eventName} [${SIM_LABEL}]`, txHash, ...(node?.agentId ? { agentId: node.agentId } : {}) });
    } else if (a.kind === "raise-cap") {
      const node = this.nodes.get(a.nodeId);
      const oldCap = node?.cap ?? 0n;
      if (node) node.cap = BigInt(a.newCapAtomic);
      eventName = `CapRaised(${a.nodeId}, ${oldCap}, ${a.newCapAtomic})`;
      this.emit({ kind: "treasury.node", message: `${eventName} [${SIM_LABEL}]`, txHash, ...(node?.agentId ? { agentId: node.agentId } : {}) });
    } else if (a.kind === "set-allow") {
      if (a.allowed) this.allowlist.add(a.payee.toLowerCase());
      else this.allowlist.delete(a.payee.toLowerCase());
      eventName = `AllowSet(${a.payee}, ${a.allowed})`;
      this.emit({ kind: "treasury.policy", message: `${eventName} [${SIM_LABEL}]`, txHash });
    } else {
      return;
    }
    const resolvedAt = this.at();
    const done = ControllerRequestSchema.parse({ ...request, status: "done", txHash, resolvedAt });
    this.requests[idx] = done;
    const ei = this.exceptions.findIndex((e) => e.id === request.exceptionId);
    const exception = this.exceptions[ei];
    if (exception) {
      this.exceptions[ei] = ExceptionRecordSchema.parse({
        ...exception,
        status: "resolved",
        decision: "approve",
        decisionReason: `${eventName} indexed [${SIM_LABEL}]`,
        resolvedBy: "owner:simulated",
        resolvedAt,
      });
    }
    this.emit({ kind: "controller.resolved", message: `${request.id} done: ${eventName} [${SIM_LABEL}]`, txHash });
  }

  // -- feed ---------------------------------------------------------------------

  private emit(partial: Omit<ActivityEvent, "id" | "at" | "simulated">): ActivityEvent {
    const event = ActivityEventSchema.parse({ ...partial, id: `ev-sim-${++this.seq}`, at: this.at(), simulated: true });
    this.events.push(event);
    for (const l of this.listeners) l(event);
    return event;
  }

  subscribe(listener: (e: ActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
  }
}

let singleton: TreasurySim | null = null;
/** One SIMULATED treasury per browser tab (module state); a reload starts over. */
export function getTreasurySim(): TreasurySim {
  singleton ??= new TreasurySim();
  return singleton;
}
