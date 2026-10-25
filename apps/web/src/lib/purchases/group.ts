import type { PurchaseGroup, PurchaseRecord } from "@overflow/schemas";
import type { FusionOutcome, OracleDecision } from "../api/contracts";

/** The Oracle and Fusion evidence that explains one purchase, from a propose response plus the stored groups. */
export interface PurchaseEvidence {
  decisions: OracleDecision[];
  outcome?: FusionOutcome;
  group?: PurchaseGroup;
}

export function attachDecisions(input: {
  purchases: readonly PurchaseRecord[];
  groups: readonly PurchaseGroup[];
  decisions: readonly OracleDecision[];
  merges: readonly FusionOutcome[];
}): { byPurchase: Map<string, PurchaseEvidence>; refusedOutcomes: FusionOutcome[] } {
  const byPurchase = new Map<string, PurchaseEvidence>();
  for (const p of input.purchases) {
    const group = p.purchaseGroupId ? input.groups.find((g) => g.id === p.purchaseGroupId) : undefined;
    const outcome = input.merges.find((m) => m.listingId === p.resourceId && (group ? m.merge : true));
    const requestIds = group?.requestIds ?? outcome?.requestIds;
    const decisions = input.decisions.filter((d) =>
      requestIds ? requestIds.includes(d.requestId) : d.chosen === p.resourceId,
    );
    byPurchase.set(p.id, { decisions, ...(outcome ? { outcome } : {}), ...(group ? { group } : {}) });
  }
  return { byPurchase, refusedOutcomes: input.merges.filter((m) => !m.merge) };
}
