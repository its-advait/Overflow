import { bigIntToAtomic, formatUsdc, overflowTreasuryAbi, type Address, type AtomicAmount } from "@overflow/schemas";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { refusal, type Refusal } from "./refusals";

/** IOverflowTreasury.Node as getNode returns it. */
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

/** The treasury reads the tools need. Tests inject a fake; production uses viem over BASE_SEPOLIA_RPC_URL. */
export interface ChainReader {
  nodeOfKey(key: Address): Promise<bigint>;
  getNode(id: bigint): Promise<TreasuryNode>;
  remaining(id: bigint): Promise<bigint>;
  allowlist(payee: Address): Promise<boolean>;
  nodeAllow(id: bigint, payee: Address): Promise<boolean>;
}

export function viemChainReader(rpcUrl: string, treasury: Address): ChainReader {
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const base = { address: treasury, abi: overflowTreasuryAbi } as const;
  return {
    nodeOfKey: (key) => client.readContract({ ...base, functionName: "nodeOfKey", args: [key] }) as Promise<bigint>,
    getNode: (id) => client.readContract({ ...base, functionName: "getNode", args: [id] }) as unknown as Promise<TreasuryNode>,
    remaining: (id) => client.readContract({ ...base, functionName: "remaining", args: [id] }) as Promise<bigint>,
    allowlist: (payee) => client.readContract({ ...base, functionName: "allowlist", args: [payee] }) as Promise<boolean>,
    nodeAllow: (id, payee) => client.readContract({ ...base, functionName: "nodeAllow", args: [id, payee] }) as Promise<boolean>,
  };
}

export interface NodePolicy {
  id: string;
  capAtomic: AtomicAmount;
  spentAtomic: AtomicAmount;
  maxPerCallAtomic: AtomicAmount;
  /** Unix seconds. */
  expiry: string;
  paused: boolean;
  restricted: boolean;
  expired: boolean;
}

export interface EffectivePolicy {
  /** The signer's node id, or null when the key is not registered (UnknownAgent). */
  nodeId: string | null;
  /** remaining(id): min over the node and its ancestors of cap - spent. */
  remainingAtomic: AtomicAmount;
  remainingUsdc: string;
  /** min maxPerCall over the node and its ancestors: settle() checks every one of them. */
  perCallAtomic: AtomicAmount;
  perCallUsdc: string;
  /** Why every payment would revert right now regardless of amount or payee, else null. */
  blocked: Refusal | null;
  /** Signer's node first, then its ancestors up to the root (parent 0). */
  nodes: NodePolicy[];
}

const MAX_WALK = 16; // MAX_DEPTH is 2; this only guards against a malformed tree

/**
 * Mirrors OverflowTreasury._authorize step 5 (paused, expiry, maxPerCall on every ancestor) and remaining().
 * Chain reads only; nothing here is a promise that settle() will pass, the treasury decides at settlement.
 */
export async function effectivePolicy(reader: ChainReader, key: Address, nowSeconds: number): Promise<EffectivePolicy> {
  const id = await reader.nodeOfKey(key);
  if (id === 0n) {
    return {
      nodeId: null,
      remainingAtomic: "0",
      remainingUsdc: formatUsdc(0n),
      perCallAtomic: "0",
      perCallUsdc: formatUsdc(0n),
      blocked: refusal("UnknownAgent", [key], "client-precheck (chain read: nodeOfKey)"),
      nodes: [],
    };
  }
  const nodes: NodePolicy[] = [];
  let blocked: Refusal | null = null;
  let perCall: bigint | null = null;
  let n = id;
  for (let i = 0; n !== 0n && i < MAX_WALK; i++) {
    const node = await reader.getNode(n);
    const expired = BigInt(nowSeconds) >= node.expiry;
    nodes.push({
      id: n.toString(),
      capAtomic: bigIntToAtomic(node.cap),
      spentAtomic: bigIntToAtomic(node.spent),
      maxPerCallAtomic: bigIntToAtomic(node.maxPerCall),
      expiry: node.expiry.toString(),
      paused: node.paused,
      restricted: node.restricted,
      expired,
    });
    if (!blocked && node.paused) blocked = refusal("Paused", [n.toString()], "client-precheck (chain read: getNode)");
    if (!blocked && expired) blocked = refusal("Expired", [n.toString()], "client-precheck (chain read: getNode)");
    if (perCall === null || node.maxPerCall < perCall) perCall = node.maxPerCall;
    n = node.parent;
  }
  const remaining = await reader.remaining(id);
  return {
    nodeId: id.toString(),
    remainingAtomic: bigIntToAtomic(remaining),
    remainingUsdc: formatUsdc(remaining),
    perCallAtomic: bigIntToAtomic(perCall ?? 0n),
    perCallUsdc: formatUsdc(perCall ?? 0n),
    blocked,
    nodes,
  };
}

/**
 * The amount/payee checks of _authorize step 4-5 as a precheck: which node would revert first for this value and
 * payee. Returns null when the chain reads predict no revert (the treasury still has the last word).
 */
export async function predictRefusal(
  reader: ChainReader,
  policy: EffectivePolicy,
  value: bigint,
  payTo: Address,
  allowlisted: boolean,
): Promise<Refusal | null> {
  if (policy.blocked) return policy.blocked;
  if (!allowlisted) return refusal("PayeeNotAllowed", ["0"], "client-precheck (chain read: allowlist)");
  for (const node of policy.nodes) {
    const id = BigInt(node.id);
    if (value > BigInt(node.maxPerCallAtomic)) return refusal("OverPerCall", [node.id], "client-precheck (chain read: getNode)");
    if (node.restricted && !(await reader.nodeAllow(id, payTo))) return refusal("PayeeNotAllowed", [node.id], "client-precheck (chain read: nodeAllow)");
    if (BigInt(node.spentAtomic) + value > BigInt(node.capAtomic)) return refusal("OverBudget", [node.id], "client-precheck (chain read: getNode)");
  }
  return null;
}
