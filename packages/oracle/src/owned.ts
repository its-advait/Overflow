import type { Repositories } from "@overflow/database";
import type { IdentifiedListing, Rejection } from "./types";

// ---------------------------------------------------------------------------
// Existing-asset check (SPEC "Oracle" > Existing-asset check): skip resources
// the organization already bought. "Bought" means a SETTLED purchase; a funded
// but undelivered escrow is not owned yet. The same bytes from another seller
// (equal manifestHash) count as owned too.
// ---------------------------------------------------------------------------

export interface OwnedResource {
  resourceId: string;
  manifestHash: string;
  productId: string;
  purchaseId: string;
}

export interface SkipOwnedResult<L extends IdentifiedListing> {
  kept: L[];
  skipped: Rejection[];
}

export function skipOwned<L extends IdentifiedListing>(
  listings: readonly L[],
  owned: readonly OwnedResource[],
): SkipOwnedResult<L> {
  const byId = new Map(owned.map((o) => [o.resourceId, o]));
  const byHash = new Map(owned.map((o) => [o.manifestHash.toLowerCase(), o]));
  const kept: L[] = [];
  const skipped: Rejection[] = [];
  for (const listing of listings) {
    const hit = byId.get(listing.id) ?? byHash.get(listing.manifestHash.toLowerCase());
    if (!hit) {
      kept.push(listing);
      continue;
    }
    const how = hit.resourceId === listing.id ? "resource" : `same manifestHash as resource ${hit.resourceId}`;
    skipped.push({
      listingId: listing.id,
      reason: "owned",
      detail: `already bought (${how}, purchase ${hit.purchaseId})`,
    });
  }
  return { kept, skipped };
}

type OwnedRepos = Pick<Repositories, "missions" | "purchases" | "resources">;

/** Every SETTLED purchase of the organization, with the resource's manifestHash. */
export async function loadOwnedResources(repos: OwnedRepos, organizationId: string): Promise<OwnedResource[]> {
  const missions = await repos.missions.listByOrganization(organizationId);
  const owned: OwnedResource[] = [];
  for (const mission of missions) {
    const purchases = await repos.purchases.listByMission(mission.id);
    for (const p of purchases) {
      if (p.status !== "SETTLED") continue;
      const resource = await repos.resources.getById(p.resourceId);
      owned.push({
        resourceId: p.resourceId,
        manifestHash: resource?.manifestHash ?? p.resourceManifestHash,
        productId: resource?.productId ?? "",
        purchaseId: p.id,
      });
    }
  }
  return owned;
}
