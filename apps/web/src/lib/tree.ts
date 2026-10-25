import { parseDecodedRevert, type ActivityEvent, type ControllerRequest, type NodeStatus } from "@overflow/schemas";

// ---------------------------------------------------------------------------
// Pure helpers for the delegation tree. Everything here is integer arithmetic
// on atomic USDC; nothing reads the network or a local flag.
// ---------------------------------------------------------------------------

export interface TreeNode<T> {
  node: T;
  children: TreeNode<T>[];
}

/** Children under their `parent` id, ordered by id; a node whose parent is 0 or unknown is a root. */
export function buildNodeTree<T extends { id: number; parent: number }>(nodes: readonly T[]): TreeNode<T>[] {
  const sorted = [...nodes].sort((a, b) => a.id - b.id);
  const wrapped = new Map<number, TreeNode<T>>(sorted.map((n) => [n.id, { node: n, children: [] }]));
  const roots: TreeNode<T>[] = [];
  for (const w of wrapped.values()) {
    const parent = w.node.parent === 0 ? undefined : wrapped.get(w.node.parent);
    if (parent && parent !== w) parent.children.push(w);
    else roots.push(w);
  }
  return roots;
}

const big = (v: bigint | string): bigint => (typeof v === "bigint" ? v : BigInt(v));

/** spent / cap as a percentage with two decimals, bigint math, clamped to [0, 100]. cap 0 reads 0. */
export function barPercent(spent: bigint | string, cap: bigint | string): number {
  const c = big(cap);
  if (c <= 0n) return 0;
  const s = big(spent);
  if (s <= 0n) return 0;
  if (s >= c) return 100;
  return Number((s * 10_000n) / c) / 100;
}

export interface WalkNode {
  id: number;
  parent: number;
  paused: boolean;
  /** unix seconds */
  expiry: bigint | string;
}

/** Self first, then every ancestor up to the root (stops on a missing parent or a cycle). */
export function ancestorsOf<T extends { id: number; parent: number }>(nodes: ReadonlyMap<number, T>, id: number): T[] {
  const out: T[] = [];
  const seen = new Set<number>();
  let cursor: number | undefined = id;
  while (cursor !== undefined && cursor !== 0 && !seen.has(cursor)) {
    seen.add(cursor);
    const n = nodes.get(cursor);
    if (!n) break;
    out.push(n);
    cursor = n.parent;
  }
  return out;
}

/** The status settle() would see: nearest paused node wins, then nearest expired node, else running. */
export function deriveStatus(
  nodes: ReadonlyMap<number, WalkNode>,
  id: number,
  nowSeconds: number | bigint,
): { status: NodeStatus; pausedBy: number | null; expiredBy: number | null } {
  const now = BigInt(nowSeconds);
  let pausedBy: number | null = null;
  let expiredBy: number | null = null;
  for (const n of ancestorsOf(nodes, id)) {
    if (pausedBy === null && n.paused) pausedBy = n.id;
    if (expiredBy === null && big(n.expiry) <= now) expiredBy = n.id;
  }
  return { status: pausedBy !== null ? "paused" : expiredBy !== null ? "expired" : "running", pausedBy, expiredBy };
}

/** The contract's remaining(id): the smallest cap - spent over the node and its ancestors (never negative). */
export function remainingOf<T extends { id: number; parent: number; cap: bigint; spent: bigint }>(nodes: ReadonlyMap<number, T>, id: number): bigint {
  let best: bigint | null = null;
  for (const n of ancestorsOf(nodes, id)) {
    const r = n.cap > n.spent ? n.cap - n.spent : 0n;
    if (best === null || r < best) best = r;
  }
  return best ?? 0n;
}

/** "expired", "12d 3h", "2h 05m", "4m 09s" or "30s". */
export function expiryCountdown(expiry: bigint | string, nowSeconds: number): string {
  const left = Number(big(expiry) - BigInt(Math.floor(nowSeconds)));
  if (left <= 0) return "expired";
  const d = Math.floor(left / 86_400);
  const h = Math.floor((left % 86_400) / 3_600);
  const m = Math.floor((left % 3_600) / 60);
  const s = left % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Controller requests whose action targets this node (pause, unpause, raise-cap). */
export function nodeRequests(requests: readonly ControllerRequest[], nodeId: number): ControllerRequest[] {
  return requests.filter((r) => "nodeId" in r.action && r.action.nodeId === nodeId);
}

/** The node id a treasury revert names, e.g. OverBudget(1) -> 1. Null when the first argument is not a node id. */
export function bindingNodeOf(decodedRevert: string | undefined): number | null {
  if (!decodedRevert) return null;
  const { name, args } = parseDecodedRevert(decodedRevert);
  if (!["Paused", "Expired", "OverPerCall", "OverBudget", "PayeeNotAllowed", "UnknownAgent"].includes(name)) return null;
  const first = args[0];
  if (first === undefined || !/^\d+$/.test(first)) return null;
  const id = Number(first);
  return id > 0 ? id : null;
}

/**
 * Refusals that belong on one node's panel: policy.blocked events raised by its agent, plus any
 * whose decoded revert names this node as the binding one (an ancestor's cap stops a grandchild's
 * payment with OverBudget(<ancestor>)). Newest first, de-duplicated.
 */
export function refusalsFor(events: readonly ActivityEvent[], node: { id: number; agent: { id: string } | null }): ActivityEvent[] {
  const seen = new Set<string>();
  const out: ActivityEvent[] = [];
  for (const e of events) {
    if (e.kind !== "policy.blocked" || seen.has(e.id)) continue;
    const mine = (node.agent !== null && e.agentId === node.agent.id) || bindingNodeOf(e.decodedRevert) === node.id;
    if (!mine) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
