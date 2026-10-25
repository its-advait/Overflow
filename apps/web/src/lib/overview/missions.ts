import type { MissionRecord, MissionStatus } from "@overflow/schemas";
import type { AllocationBreakdown } from "@/lib/api/contracts";

/** Missions still in flight: not complete, not cancelled. Exhaustive so a new status is placed deliberately. */
const IN_FLIGHT: Record<MissionStatus, boolean> = { draft: true, planning: true, confirmed: true, active: true, complete: false, cancelled: false };

const newestFirst = (a: MissionRecord, b: MissionRecord): number => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

export function activeMissions(missions: readonly MissionRecord[]): MissionRecord[] {
  return missions.filter((m) => IN_FLIGHT[m.status]).sort(newestFirst);
}

/** "This mission" for the Spent card: the newest active mission, else the newest mission of any status. */
export function pickMission(missions: readonly MissionRecord[]): MissionRecord | undefined {
  const sorted = [...missions].sort(newestFirst);
  return sorted.find((m) => m.status === "active") ?? sorted[0];
}

/**
 * Spent per the books: the data-expense the ledger booked to the mission's
 * purchases (the Fusion allocation breakdown's `bookedAtomic`). An order still
 * in escrow is booked 0, a refund never becomes an expense, so this reads
 * exactly what left the treasury for delivered data. bigint only.
 */
export function spentForMission(purchaseIds: readonly string[], allocations: readonly AllocationBreakdown[]): bigint {
  const ids = new Set(purchaseIds);
  let sum = 0n;
  for (const a of allocations) if (ids.has(a.purchaseId)) sum += BigInt(a.bookedAtomic);
  return sum;
}
