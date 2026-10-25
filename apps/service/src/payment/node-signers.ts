import type { Address } from "@overflow/schemas";
import type { PrivateKeyAccount } from "viem/accounts";
import type { AgentKeys } from "../orchestration/agent-keys.js";
import { ORCHESTRATOR_AGENT_ID, ROLE_AGENT_IDS, ROLES } from "../orchestration/delegation-plan.js";

// ---------------------------------------------------------------------------
// Which agent key may sign for a purchase's paying node. The order carries only
// `payingNodeId`; the chain (treasury.nodeOfKey) is the sole authority on which
// key owns that node. A key is handed out only after nodeOfKey(key) == nodeId was
// read on chain; an unknown node throws and nothing falls back to another key.
// Keys sign EIP-712 only (TransferWithAuthorization, Accept); they never send
// transactions and never hold funds.
// ---------------------------------------------------------------------------

export class NoSignerForNodeError extends Error {
  constructor(
    public readonly nodeId: number,
    public readonly detail: string,
  ) {
    super(`no agent key owns treasury node ${nodeId}: ${detail}`);
    this.name = "NoSignerForNodeError";
  }
}

/** The one chain read this module needs; tests pass a fake. */
export interface NodeOfKeyReader {
  nodeOfKey(key: Address): Promise<bigint>;
}

export interface NodeSigner {
  readonly account: PrivateKeyAccount;
  readonly agentId: string;
  readonly nodeId: number;
}

export interface NodeSigners {
  /** The key whose treasury node is `nodeId`, verified on chain (cached after the first confirmation). */
  signerFor(nodeId: number): Promise<NodeSigner>;
  /** Every candidate key with its agent id; nothing here claims a node. */
  candidates(): ReadonlyArray<{ agentId: string; address: Address }>;
}

export interface NodeSignersOptions {
  keys: AgentKeys;
  chain: NodeOfKeyReader;
  log?: ((line: string) => void) | undefined;
}

export function createNodeSigners(opts: NodeSignersOptions): NodeSigners {
  const log = opts.log ?? (() => {});
  const candidates: ReadonlyArray<{ agentId: string; account: PrivateKeyAccount }> = [
    { agentId: ORCHESTRATOR_AGENT_ID, account: opts.keys.root },
    ...ROLES.map((role) => ({ agentId: ROLE_AGENT_IDS[role], account: opts.keys.children[role] })),
  ];
  const byNode = new Map<number, NodeSigner>();

  return {
    candidates: () => candidates.map((c) => ({ agentId: c.agentId, address: c.account.address })),
    async signerFor(nodeId: number): Promise<NodeSigner> {
      if (!Number.isInteger(nodeId) || nodeId <= 0) throw new NoSignerForNodeError(nodeId, "node ids are positive integers");
      const cached = byNode.get(nodeId);
      if (cached) {
        // Re-confirm on every use: a key the owner revoked or moved must not keep signing from the cache.
        const live = await opts.chain.nodeOfKey(cached.account.address);
        if (live === BigInt(nodeId)) return cached;
        byNode.delete(nodeId);
        log(`[node-signers] ${cached.agentId} no longer owns node ${nodeId} (nodeOfKey=${live}); dropped from cache`);
      }
      const seen: string[] = [];
      for (const c of candidates) {
        const live = await opts.chain.nodeOfKey(c.account.address);
        seen.push(`${c.agentId}=${live}`);
        if (live === BigInt(nodeId)) {
          const signer: NodeSigner = { account: c.account, agentId: c.agentId, nodeId };
          byNode.set(nodeId, signer);
          log(`[node-signers] node ${nodeId} is ${c.agentId} (${c.account.address}), confirmed by treasury.nodeOfKey`);
          return signer;
        }
      }
      throw new NoSignerForNodeError(nodeId, `treasury.nodeOfKey per candidate: ${seen.join(", ")}`);
    },
  };
}
