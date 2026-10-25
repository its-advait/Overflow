import type { Address } from "viem";
import type { CheckedQuote, PaymentRequirements } from "@overflow/payment-client";
import type {
  EscrowStatus,
  MissionRecord,
  NetworkInfo,
  PaymentPath,
  PurchaseOrder,
  ReconciliationRun,
  ReconciliationTrigger,
  RecourseSellerView,
  ResourceRecord,
  ResourceRequestRecord,
  SellerBehaviour,
} from "@overflow/schemas";
import type { Hex } from "viem";
import type { TreasurySnapshot } from "../chain/treasury-snapshot.js";
import type { ProposeResult } from "../orchestration/oracle-port.js";
import type { MissionRunResult, RunOptions } from "../orchestration/mission-runner.js";
import type { TreasuryNode } from "../orchestration/delegation-plan.js";
import type { OrderOutcome } from "../recourse/run.js";

// ---------------------------------------------------------------------------
// Ports: what the API needs from parts of the system that later prompts build.
// Every default below refuses with NotWiredError (HTTP 501). Nothing here
// fakes a success.
// ---------------------------------------------------------------------------

export class NotWiredError extends Error {
  constructor(
    public readonly port: string,
    public readonly lands: string,
  ) {
    super(`${port} is not wired yet (lands in ${lands})`);
    this.name = "NotWiredError";
  }
}

/** Oracle + Fusion (wired: orchestration/oracle-port.ts). */
export interface OrchestrationPort {
  /** Extracts structured requirements for a mission and persists them as resource_requests. */
  planMission(mission: MissionRecord): Promise<ResourceRequestRecord[]>;
  /** Oracle recommends per open request, Fusion merges compatible ones; returns proposals the PurchaseService persists as PROPOSED plus the Oracle decisions and Fusion merges. */
  propose(mission: MissionRecord): Promise<ProposeResult>;
  /**
   * Mission runner (orchestration/mission-runner.ts): the orchestrator signs CreateChild for three sub-agents
   * (relayed gaslessly), runs their tool loops and reports. Resolves when the run has been accepted; the run's
   * progress is the activity feed. Default: NotWiredError (no agent keys / chain).
   */
  runMission(mission: MissionRecord, opts: RunOptions): Promise<{ runId: string; done: Promise<MissionRunResult> }>;
  /** The orchestrator signs PauseChild for one of its sub-agents (the controller's owner pause is separate). */
  pauseAgent(mission: MissionRecord, agentId: string): Promise<{ txHash: Hex; nodeId: number }>;
}

export interface PreparedPayment {
  authorizationDigest: Hex;
  /** Set on the coinbase-facilitator path once reserve() is confirmed. */
  reservationTxHash?: Hex | undefined;
}

export type PaymentSubmission =
  | { outcome: "submitted"; txHash: Hex }
  | { outcome: "rejected"; decodedRevert: string }
  | { outcome: "unknown"; error: string };

export type PaymentStatus =
  | { status: "funded"; txHash: Hex }
  | { status: "not-settled" }
  | { status: "unknown" };

/**
 * docs/SPEC.md "One payment interface, two paths". preparePayment takes the
 * CheckedQuote so an adapter can only sign a quote that passed checkQuote.
 * Adapters (P7.x) call treasury.settle()/reserve(); nothing in the API does.
 */
export interface PaymentAdapter {
  readonly path: PaymentPath;
  getPaymentRequirements(order: PurchaseOrder, resource: ResourceRecord): Promise<PaymentRequirements>;
  preparePayment(purchaseId: string, quote: CheckedQuote): Promise<PreparedPayment>;
  submitPayment(purchaseId: string, prepared: PreparedPayment): Promise<PaymentSubmission>;
  reconcilePayment(purchaseId: string): Promise<PaymentStatus>;
}

/** Read side of the treasury's owner allowlist (chain module). */
export interface PolicyPort {
  allowlistedPayees(): Promise<readonly Address[]>;
}

/**
 * Reconciliation job (ledger/reconciliation.ts). Reading the last run needs no
 * port (it is a table); running one needs chain balance reads, so without an
 * RPC and a deployments file the default refuses.
 */
export interface ReconciliationPort {
  run(trigger: ReconciliationTrigger): Promise<ReconciliationRun>;
}

/**
 * Read side of the treasury's delegation tree (chain/treasury-read.ts). Pure view calls:
 * nothing here signs, broadcasts or caches. The default refuses, so a service without an
 * RPC answers 501 instead of inventing node state.
 */
export interface TreasuryReadPort {
  blockNumber(): Promise<bigint>;
  nodeCount(): Promise<bigint>;
  getNode(id: bigint): Promise<TreasuryNode>;
  /** The contract's remaining(id): smallest cap - spent over the node and its ancestors. */
  remaining(id: bigint): Promise<bigint>;
  allowlist(payee: Address): Promise<boolean>;
  nodeAllow(id: bigint, payee: Address): Promise<boolean>;
}

/** The escrow as the chain holds it at one block: eth_call views plus the USDC balance. */
export interface EscrowChainRead {
  status: EscrowStatus;
  /** Unix seconds; 0 until the key is revealed. */
  challengeEnd: bigint;
  /** bytes32(0) until the key is revealed. */
  revealedKey: Hex;
  balance: bigint;
}

/**
 * Read side of one escrow order (chain/escrow-read.ts): status(), challengeEnd(), revealedKey() and the USDC
 * balance, plus the block they were read at. Pure view calls; the default refuses (501) so a service without
 * an RPC never invents an order's state.
 */
export interface EscrowReadPort {
  latest(): Promise<{ blockNumber: bigint; blockTimestamp: bigint }>;
  state(escrow: Address): Promise<EscrowChainRead>;
}

/**
 * Onchain treasury reads for the overview (chain/treasury-snapshot.ts): USDC balanceOf(treasury) and
 * reservedTotal() at one block. Without an RPC and a deployments file the default refuses; the route then
 * reports the chain part as unavailable instead of a number.
 */
export interface TreasuryPort {
  read(): Promise<TreasurySnapshot>;
}

/**
 * Judge controls over the SIMULATED recourse sellers (recourse/port.ts): which behaviour each seller account
 * plays next, and one order run end to end on the local Anvil fork. The default refuses (501): without the seller
 * keys, an Anvil RPC and an escrow factory there is nothing to run, and nothing is faked.
 */
export interface RecourseOrderInput {
  sellerAddress: Address;
  listingId: string;
  bondAtomic?: bigint | undefined;
}
export interface RecoursePort {
  sellers(): Promise<RecourseSellerView[]>;
  setBehaviour(sellerAddress: Address, behaviour: SellerBehaviour): Promise<RecourseSellerView>;
  /** Runs one order with the seller's current behaviour; resolves when the runner is done. Statuses: the indexer. */
  runOrder(input: RecourseOrderInput): Promise<OrderOutcome>;
}

/** Treasury owner/floor/reservationWindow/reservedTotal/nodeCount views plus the boot token domain (chain/network-info.ts). */
export interface NetworkInfoPort {
  read(): Promise<NetworkInfo>;
}

export interface Ports {
  orchestration: OrchestrationPort;
  adapters: Partial<Record<PaymentPath, PaymentAdapter>>;
  policy: PolicyPort;
  reconciliation: ReconciliationPort;
  treasuryRead: TreasuryReadPort;
  escrowRead: EscrowReadPort;
  treasury: TreasuryPort;
  recourse: RecoursePort;
  network: NetworkInfoPort;
}

/** Defaults for the ports later prompts build. The orchestration port is always real (createApp builds createOraclePort). */
export function defaultPorts(): Omit<Ports, "orchestration"> {
  return {
    adapters: {},
    // No chain reader yet: only escrow payTo passes checkQuote.
    policy: { allowlistedPayees: async () => [] },
    reconciliation: {
      run: async () => {
        throw new NotWiredError("ReconciliationPort.run (chain balance reads)", "BASE_SEPOLIA_RPC_URL + deployments/base-sepolia.json");
      },
    },
    treasuryRead: notWiredTreasuryRead(),
    escrowRead: notWiredEscrowRead(),
    treasury: {
      read: async () => {
        throw new NotWiredError("TreasuryPort.read (chain balance reads)", "BASE_SEPOLIA_RPC_URL + deployments/base-sepolia.json");
      },
    },
    recourse: notWiredRecourse(),
    network: {
      read: async () => {
        throw new NotWiredError("NetworkInfoPort.read (treasury view calls)", "BASE_SEPOLIA_RPC_URL + deployments/base-sepolia.json");
      },
    },
  };
}

function notWiredRecourse(): RecoursePort {
  const refuse = async (): Promise<never> => {
    throw new NotWiredError("RecoursePort (SIMULATED orders on local Anvil)", "AGENT_ROOT_KEY + RECOURSE_SELLER_KEYS + an Anvil RPC + an escrow factory (anvil:provision)");
  };
  return { sellers: refuse, setBehaviour: refuse, runOrder: refuse };
}

function notWiredEscrowRead(): EscrowReadPort {
  const refuse = async (): Promise<never> => {
    throw new NotWiredError("EscrowReadPort (escrow view calls)", "BASE_SEPOLIA_RPC_URL + deployments/base-sepolia.json");
  };
  return { latest: refuse, state: refuse };
}

function notWiredTreasuryRead(): TreasuryReadPort {
  const refuse = async (): Promise<never> => {
    throw new NotWiredError("TreasuryReadPort (treasury view calls)", "BASE_SEPOLIA_RPC_URL + deployments/base-sepolia.json");
  };
  return { blockNumber: refuse, nodeCount: refuse, getNode: refuse, remaining: refuse, allowlist: refuse, nodeAllow: refuse };
}
