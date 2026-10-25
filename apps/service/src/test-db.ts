import { createDatabase, createRepositories, seed, type DatabaseHandle, type Repositories } from "@overflow/database";
import type { PaymentRequirements } from "@overflow/payment-client";
import { USDC, type Address, type Hex, type PurchaseOrder } from "@overflow/schemas";

/** Test-only: fresh in-memory PGlite with every migration and the SIMULATED seed applied. */
export async function testDatabase(): Promise<DatabaseHandle & { repos: Repositories }> {
  const handle = await createDatabase({ url: "", pgliteDataDir: ":memory:" });
  await handle.migrate();
  await seed(handle.db, { now: NOW });
  return { ...handle, repos: createRepositories(handle.db) };
}

export const NOW = "2026-10-24T16:00:00.000Z";
export const TREASURY = "0x1111111111111111111111111111111111111111" as Address;
export const SELLER = "0x2222222222222222222222222222222222222222" as Address;
export const ESCROW = "0x3333333333333333333333333333333333333333" as Address;
export const ATTACKER = "0x4444444444444444444444444444444444444444" as Address; // SIMULATED attacker payee
export const b32 = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** A mission (root node 1) and one SIMULATED resource for the seeded organization. */
export async function fixtureMissionAndResource(repos: Repositories) {
  const mission = await repos.missions.insert({
    id: "mission-1",
    organizationId: "org-demo",
    goal: "EV registrations, monthly, US",
    budgetAtomic: "50000000",
    rootNodeId: 1,
    status: "active",
    createdAt: NOW,
  });
  const resource = await repos.resources.insert({
    id: "resource-1",
    title: "EV registrations US monthly (SIMULATED)",
    sellerId: "seller-honest",
    productId: "ev-us-monthly",
    coverage: {
      regions: ["United States"],
      dateRange: { start: "2024-01-01", end: "2026-12-31" },
      granularity: "monthly",
      fields: ["brand", "units", "state"],
      format: "csv",
    },
    license: "company-use",
    priceAtomic: "12000000",
    manifestHash: b32(5),
    seats: 10,
    simulated: true,
    createdAt: NOW,
  });
  return { mission, resource };
}

export function purchaseInput(over: Partial<Parameters<Repositories["purchases"]["create"]>[0]> = {}) {
  return {
    idempotencyKey: `mission-1:resource-1:${over.id ?? "p"}`,
    orderIdBytes32: b32(1),
    missionId: "mission-1",
    resourceId: "resource-1",
    buyerTreasury: TREASURY,
    sellerAddress: SELLER,
    escrowAddress: ESCROW,
    chainId: 84532 as const,
    tokenAddress: USDC.address,
    amountAtomic: "12000000",
    payingNodeId: 1,
    participatingAgentIds: ["agent-research", "agent-finance"],
    allocations: [
      { agentId: "agent-research", department: "research", amountAtomic: "8400000" },
      { agentId: "agent-finance", department: "finance", amountAtomic: "3600000" },
    ],
    resourceManifestHash: b32(5),
    termsHash: b32(9),
    paymentPath: "overflow-facilitator" as const,
    authorizationExpiresAt: NOW,
    ...over,
  };
}

/** A seller quote that agrees with the order (escrow payTo, exact amount, USDC v2 on 84532). */
export function quoteFor(order: PurchaseOrder, over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:84532",
    amount: order.amountAtomic,
    asset: USDC.address,
    payTo: order.escrowAddress,
    maxTimeoutSeconds: 120,
    extra: { name: "USDC", version: "2" },
    ...over,
  };
}
