import type { PurchaseRecord, PurchaseStatus, ResourceRequestRecord } from "@overflow/schemas";

// The overview's progress strip, derived only from stored rows: requests the
// Oracle filed (Discovered), purchases Fusion proposed from them (Grouped), and
// the stored purchase status for the three money events, kept apart as the
// CLAUDE.md rule asks: authorization (Authorized), escrow funding (Escrow),
// final settlement (Settled). A stage is reached only when a row proves it.

export const PROGRESS_STAGES = ["Discovered", "Grouped", "Authorized", "Escrow", "Settled"] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

const STAGE_INDEX: Record<ProgressStage, number> = { Discovered: 0, Grouped: 1, Authorized: 2, Escrow: 3, Settled: 4 };

/**
 * The furthest stage a purchase's stored status proves it reached (exhaustive: a
 * new status fails typecheck here). A refund reached escrow and came back; a
 * rejection never passed the treasury, so it stays at the proposal.
 */
export const PURCHASE_STAGE: Record<PurchaseStatus, ProgressStage> = {
  PROPOSED: "Grouped",
  RESERVED: "Authorized",
  PAYMENT_PENDING: "Authorized",
  ESCROW_FUNDED: "Escrow",
  DELIVERY_PENDING: "Escrow",
  SETTLED: "Settled",
  REFUNDED: "Escrow",
  REJECTED: "Grouped",
  PAYMENT_UNKNOWN: "Authorized",
  FAILED_BEFORE_FUNDING: "Authorized",
  RELEASED: "Authorized",
};

export interface StageCell {
  stage: ProgressStage;
  /** Requests (Discovered) or purchases that reached at least this stage. */
  count: number;
  reached: boolean;
}

export interface MissionProgress {
  stages: StageCell[];
  /** The furthest reached stage, or null for a mission with no requests yet. */
  current: ProgressStage | null;
}

export function missionProgress(input: { requests: readonly ResourceRequestRecord[]; purchases: readonly PurchaseRecord[] }): MissionProgress {
  const discovered = input.requests.filter((r) => r.status !== "withdrawn").length;
  const reachedAtLeast = (stage: ProgressStage): number => input.purchases.filter((p) => STAGE_INDEX[PURCHASE_STAGE[p.status]] >= STAGE_INDEX[stage]).length;
  const counts: Record<ProgressStage, number> = {
    Discovered: discovered,
    Grouped: reachedAtLeast("Grouped"),
    Authorized: reachedAtLeast("Authorized"),
    Escrow: reachedAtLeast("Escrow"),
    Settled: reachedAtLeast("Settled"),
  };
  const stages = PROGRESS_STAGES.map((stage) => ({ stage, count: counts[stage], reached: counts[stage] > 0 }));
  const current = [...stages].reverse().find((s) => s.reached)?.stage ?? null;
  return { stages, current };
}
