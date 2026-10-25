// SIMULATED fixtures shared by the unit tests. Not exported from the package index.
import { USDC, type PurchaseOrder } from "@overflow/schemas";
import type { PaymentRequirements } from "./x402";

export const ESCROW = "0x4444444444444444444444444444444444444444" as const;
export const SELLER = "0x5555555555555555555555555555555555555555" as const;
export const TREASURY = "0x1111111111111111111111111111111111111111" as const;
export const ATTACKER = "0x6666666666666666666666666666666666666666" as const;

export function makeOrder(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: "po_1",
    orderIdBytes32: `0x${"11".repeat(32)}`,
    missionId: "m_1",
    resourceId: "r_1",
    buyerTreasury: TREASURY,
    sellerAddress: SELLER,
    escrowAddress: ESCROW,
    chainId: 84532,
    tokenAddress: USDC.address,
    amountAtomic: "8400000",
    payingNodeId: 2,
    participatingAgentIds: ["a1"],
    allocations: [],
    resourceManifestHash: `0x${"22".repeat(32)}`,
    termsHash: `0x${"33".repeat(32)}`,
    paymentPath: "overflow-facilitator",
    txHashes: [],
    createdAt: "2026-10-24T16:00:00Z",
    authorizationExpiresAt: "2026-10-24T16:10:00Z",
    status: "RESERVED",
    ...overrides,
  };
}

export function makeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:84532",
    amount: "8400000",
    asset: USDC.address,
    payTo: ESCROW,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}
