import type { FetchLike, NodeSigner } from "@overflow/payment-client";
import { CHAIN_ID, type Address } from "@overflow/schemas";
import { effectivePolicy, type ChainReader, type EffectivePolicy } from "./chain";
import { pay, type PayResult } from "./pay";
import { quote, type QuoteResult } from "./quote";

export const TOOL_NAMES = ["overflow_budget", "overflow_quote", "overflow_pay"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Everything the tools touch, injected so tests run with a fake fetch and a fake chain. */
export interface Deps {
  fetch: FetchLike;
  chain: ChainReader;
  signer: NodeSigner;
  /** Where the signer's key came from ("NODE_PRIVATE_KEY (env)" or a keystore name); never the key itself. */
  signerSource: string;
  treasury: Address;
  serviceUrl: string;
  now: () => number;
}

export interface BudgetResult extends EffectivePolicy {
  chainId: typeof CHAIN_ID;
  treasury: Address;
  signer: Address;
  signerSource: string;
  source: "chain reads: nodeOfKey, getNode (every ancestor), remaining";
}

export async function budgetTool(deps: Deps): Promise<BudgetResult> {
  const policy = await effectivePolicy(deps.chain, deps.signer.address, deps.now());
  return {
    ...policy,
    chainId: CHAIN_ID,
    treasury: deps.treasury,
    signer: deps.signer.address,
    signerSource: deps.signerSource,
    source: "chain reads: nodeOfKey, getNode (every ancestor), remaining",
  };
}

export function quoteTool(deps: Deps, url: string): Promise<QuoteResult> {
  return quote(deps, url);
}

export function payTool(deps: Deps, url: string, maxAmount: string): Promise<PayResult> {
  return pay(deps, url, maxAmount);
}
