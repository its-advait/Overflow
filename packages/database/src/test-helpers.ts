import type { Address, Hex } from "@overflow/schemas";
import type { SQL } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "./client";
import { createRepositories, type Repositories } from "./repositories";

/** Fresh in-memory PGlite database with every migration applied. Test-only. */
export async function freshDatabase(): Promise<DatabaseHandle & { repos: Repositories }> {
  const handle = await createDatabase({ url: "", pgliteDataDir: ":memory:" });
  await handle.migrate();
  return { ...handle, repos: createRepositories(handle.db) };
}

export const ADDR = "0x1111111111111111111111111111111111111111" as Address;
export const ADDR2 = "0x2222222222222222222222222222222222222222" as Address;
export const B32 = `0x${"33".repeat(32)}` as Hex;
export const b32 = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
export const NOW = "2026-10-24T16:00:00.000Z";

/** Organization, two agents, a mission and a resource; returns their ids. */
export async function seedFixture(repos: Repositories) {
  const org = await repos.organizations.insert({
    id: "org-test",
    name: "FICTIONAL Test Co",
    departments: ["research", "finance"],
    simulated: true,
  });
  const research = await repos.agents.insert({
    id: "agent-research",
    organizationId: org.id,
    name: "research",
    department: "research",
    role: "analyst",
    key: ADDR,
  });
  const finance = await repos.agents.insert({
    id: "agent-finance",
    organizationId: org.id,
    name: "finance",
    department: "finance",
    role: "analyst",
    key: ADDR2,
  });
  const mission = await repos.missions.insert({
    id: "mission-1",
    organizationId: org.id,
    goal: "EV registrations, monthly, US",
    budgetAtomic: "50000000",
    rootNodeId: 1,
    status: "active",
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
    manifestHash: B32,
    seats: 10,
    simulated: true,
  });
  return { org, research, finance, mission, resource };
}

export function purchaseInput(over: Partial<Parameters<Repositories["purchases"]["create"]>[0]> = {}) {
  return {
    idempotencyKey: "mission-1:resource-1:1",
    orderIdBytes32: b32(1),
    missionId: "mission-1",
    resourceId: "resource-1",
    buyerTreasury: ADDR,
    sellerAddress: ADDR2,
    escrowAddress: ADDR2,
    chainId: 84532 as const,
    tokenAddress: ADDR,
    amountAtomic: "12000000",
    payingNodeId: 1,
    participatingAgentIds: ["agent-research", "agent-finance"],
    allocations: [
      { agentId: "agent-research", department: "research", amountAtomic: "8400000" },
      { agentId: "agent-finance", department: "finance", amountAtomic: "3600000" },
    ],
    resourceManifestHash: B32,
    termsHash: b32(9),
    paymentPath: "overflow-facilitator" as const,
    authorizationExpiresAt: NOW,
    ...over,
  };
}

/** Raw query rows, whichever driver is underneath (postgres-js returns an array, PGlite `{ rows }`). */
export async function queryRows<T>(db: DatabaseHandle["db"], q: SQL): Promise<T[]> {
  const result = (await db.execute(q)) as unknown;
  if (Array.isArray(result)) return result as T[];
  return (result as { rows: T[] }).rows;
}
