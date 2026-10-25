import type { Address } from "viem";
import type { CheckedQuote, PaymentRequirements } from "@overflow/payment-client";
import type {
  ExceptionRecord,
  MissionRecord,
  PaymentPath,
  PurchaseOrder,
  ResourceRecord,
  ResourceRequestRecord,
} from "@overflow/schemas";
import type { Hex } from "viem";
import type { ProposeInput } from "../orchestration/purchase-service.js";

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

/** Oracle + Fusion (P4.1 / P4.2). */
export interface OrchestrationPort {
  /** Extracts structured requirements for a mission and persists them as resource_requests. */
  planMission(mission: MissionRecord): Promise<ResourceRequestRecord[]>;
  /** Oracle ranks, Fusion merges; returns proposals the PurchaseService persists as PROPOSED. */
  propose(mission: MissionRecord): Promise<ProposeInput[]>;
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

export interface ReconciliationSummary {
  ranAt: string;
  treasuryBalanceAtomic: string;
  ledgerTreasuryAtomic: string;
  differenceAtomic: string;
  openEscrows: number;
  exceptions: ExceptionRecord[];
}

/** Reconciliation job (P4.4). */
export interface ReconciliationPort {
  latest(): Promise<ReconciliationSummary | null>;
}

export interface Ports {
  orchestration: OrchestrationPort;
  adapters: Partial<Record<PaymentPath, PaymentAdapter>>;
  policy: PolicyPort;
  reconciliation: ReconciliationPort;
}

export function defaultPorts(): Ports {
  return {
    orchestration: {
      planMission: async () => {
        throw new NotWiredError("OrchestrationPort.planMission (Oracle)", "P4.1");
      },
      propose: async () => {
        throw new NotWiredError("OrchestrationPort.propose (Oracle + Fusion)", "P4.2");
      },
    },
    adapters: {},
    // No chain reader yet: only escrow payTo passes checkQuote.
    policy: { allowlistedPayees: async () => [] },
    reconciliation: { latest: async () => null },
  };
}
