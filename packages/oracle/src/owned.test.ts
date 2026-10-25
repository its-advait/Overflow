import { createDatabase, createRepositories, type DatabaseHandle, type Repositories } from "@overflow/database";
import { loadCatalog } from "@overflow/datasets";
import type { Address, Hex } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadOwnedResources, skipOwned } from "./owned";

const ADDR = "0x1111111111111111111111111111111111111111" as Address;
const ADDR2 = "0x2222222222222222222222222222222222222222" as Address;
const b32 = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const NOW = "2026-10-24T16:00:00.000Z";

async function freshDatabase(): Promise<DatabaseHandle & { repos: Repositories }> {
  const handle = await createDatabase({ url: "", pgliteDataDir: ":memory:" });
  await handle.migrate();
  return { ...handle, repos: createRepositories(handle.db) };
}

describe("existing-asset check", () => {
  let handle: Awaited<ReturnType<typeof freshDatabase>>;
  let nationalHash: Hex;

  beforeAll(async () => {
    handle = await freshDatabase();
    const { repos } = handle;
    const catalog = await loadCatalog();
    const national = catalog.listings.find((l) => l.id === "listing-national-monthly-2024-2026")!;
    nationalHash = national.manifestHash;

    await repos.organizations.insert({ id: "org-test", name: "FICTIONAL Test Co", departments: ["research"], simulated: true });
    await repos.organizations.insert({ id: "org-other", name: "FICTIONAL Other Co", departments: ["research"], simulated: true });
    await repos.agents.insert({ id: "agent-r", organizationId: "org-test", name: "research", department: "research", role: "analyst", key: ADDR });
    await repos.missions.insert({ id: "m-1", organizationId: "org-test", goal: "EV", budgetAtomic: "50000000", rootNodeId: 1, status: "active" });
    await repos.missions.insert({ id: "m-2", organizationId: "org-test", goal: "EV again", budgetAtomic: "50000000", rootNodeId: 1, status: "active" });
    // The catalog entry becomes a resources row (same id and manifestHash).
    await repos.resources.insert({
      id: national.id,
      title: national.title,
      sellerId: national.sellerId,
      productId: national.productId,
      coverage: national.coverage,
      license: national.license,
      priceAtomic: national.priceAtomic,
      manifestHash: national.manifestHash,
      seats: national.seats,
      simulated: true,
    });
    const california = catalog.listings.find((l) => l.id === "listing-california-monthly-2024-2026")!;
    await repos.resources.insert({
      id: california.id,
      title: california.title,
      sellerId: california.sellerId,
      productId: california.productId,
      coverage: california.coverage,
      license: california.license,
      priceAtomic: california.priceAtomic,
      manifestHash: california.manifestHash,
      seats: california.seats,
      simulated: true,
    });

    const base = {
      missionId: "m-1",
      buyerTreasury: ADDR,
      sellerAddress: ADDR2,
      escrowAddress: ADDR2,
      chainId: 84532 as const,
      tokenAddress: ADDR,
      payingNodeId: 1,
      participatingAgentIds: ["agent-r"],
      termsHash: b32(9),
      paymentPath: "overflow-facilitator" as const,
      authorizationExpiresAt: NOW,
    };
    // Settled purchase of the national set.
    const settled = await repos.purchases.create({
      ...base,
      idempotencyKey: "m-1:national:1",
      orderIdBytes32: b32(1),
      resourceId: national.id,
      amountAtomic: national.priceAtomic,
      allocations: [{ agentId: "agent-r", department: "research", amountAtomic: national.priceAtomic }],
      resourceManifestHash: national.manifestHash,
    });
    for (const to of ["RESERVED", "PAYMENT_PENDING", "ESCROW_FUNDED", "DELIVERY_PENDING", "SETTLED"] as const) {
      await repos.purchases.transition(settled.id, to);
    }
    // Funded but not delivered purchase of the California set: not owned yet.
    const funded = await repos.purchases.create({
      ...base,
      missionId: "m-2",
      idempotencyKey: "m-2:california:1",
      orderIdBytes32: b32(2),
      resourceId: california.id,
      amountAtomic: california.priceAtomic,
      allocations: [{ agentId: "agent-r", department: "research", amountAtomic: california.priceAtomic }],
      resourceManifestHash: california.manifestHash,
    });
    for (const to of ["RESERVED", "PAYMENT_PENDING", "ESCROW_FUNDED"] as const) {
      await repos.purchases.transition(funded.id, to);
    }
  });
  afterAll(() => handle.close());

  it("loadOwnedResources returns only SETTLED purchases of the organization", async () => {
    const owned = await loadOwnedResources(handle.repos, "org-test");
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({
      resourceId: "listing-national-monthly-2024-2026",
      manifestHash: nationalHash,
      productId: "ev-registrations-national-monthly-2024-2026",
    });
    expect(await loadOwnedResources(handle.repos, "org-other")).toEqual([]);
  });

  it("skipOwned drops the owned listing and the same-manifestHash duplicate from seller B", async () => {
    const owned = await loadOwnedResources(handle.repos, "org-test");
    const { listings } = await loadCatalog();
    const { kept, skipped } = skipOwned(listings, owned);
    const skippedIds = skipped.map((s) => s.listingId).sort();
    // Three catalog listings sell the same bytes (seller A company-use, seller B, single-user).
    expect(skippedIds).toEqual([
      "listing-national-monthly-2024-2026",
      "listing-national-monthly-2024-2026-seller-b",
      "listing-national-monthly-2024-2026-single-user",
    ]);
    expect(skipped.every((s) => s.reason === "owned")).toBe(true);
    expect(skipped.find((s) => s.listingId === "listing-national-monthly-2024-2026-seller-b")!.detail).toContain("same manifestHash");
    expect(kept.map((l) => l.id)).toContain("listing-california-monthly-2024-2026");
    expect(kept).toHaveLength(3);
  });

  it("skipOwned with nothing owned keeps everything", async () => {
    const { listings } = await loadCatalog();
    expect(skipOwned(listings, []).kept).toHaveLength(6);
  });
});
