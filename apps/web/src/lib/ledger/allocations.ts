import type { AllocationBreakdown } from "@/lib/api/contracts";

// Fusion allocation breakdown (SPEC "Fusion": one transfer onchain, department
// shares in the subledger). bigint everywhere; percentages are basis points.

export interface AllocationLine {
  department: string;
  bookedAtomic: bigint;
  allocatedAtomic: bigint | null;
  /** Share of the purchase's booked total, in basis points (0..10000). */
  shareBps: bigint;
  /** True when the books expensed exactly the planned share (or nothing is planned to compare). */
  matches: boolean;
}

export interface PurchaseBreakdown {
  purchaseId: string;
  purchaseGroupId: string | null;
  /** Part of a Fusion purchase group, i.e. several agents' requests charged once onchain. */
  merged: boolean;
  bookedAtomic: bigint;
  allocatedAtomic: bigint;
  lines: AllocationLine[];
}

export interface DepartmentBreakdown {
  department: string;
  bookedAtomic: bigint;
  purchases: { purchaseId: string; bookedAtomic: bigint; merged: boolean }[];
}

/** Basis points of part over total; 0 when the total is zero. Integer arithmetic only. */
export function bps(part: bigint, total: bigint): bigint {
  if (total === 0n) return 0n;
  return (part * 10000n) / total;
}

/** "68.18%" from basis points. */
export function formatBps(v: bigint): string {
  const whole = v / 100n;
  const frac = (v % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}%`;
}

export function byPurchase(rows: readonly AllocationBreakdown[]): PurchaseBreakdown[] {
  const groups = new Map<string, AllocationBreakdown[]>();
  for (const r of rows) groups.set(r.purchaseId, [...(groups.get(r.purchaseId) ?? []), r]);
  return [...groups.entries()]
    .map(([purchaseId, lines]) => {
      const bookedAtomic = lines.reduce((s, l) => s + BigInt(l.bookedAtomic), 0n);
      const allocatedAtomic = lines.reduce((s, l) => s + (l.allocatedAtomic === null ? 0n : BigInt(l.allocatedAtomic)), 0n);
      const purchaseGroupId = lines[0]?.purchaseGroupId ?? null;
      return {
        purchaseId,
        purchaseGroupId,
        merged: purchaseGroupId !== null,
        bookedAtomic,
        allocatedAtomic,
        lines: lines
          .map((l): AllocationLine => {
            const booked = BigInt(l.bookedAtomic);
            const allocated = l.allocatedAtomic === null ? null : BigInt(l.allocatedAtomic);
            return {
              department: l.department,
              bookedAtomic: booked,
              allocatedAtomic: allocated,
              shareBps: bps(booked, bookedAtomic),
              // Nothing booked yet (order still in escrow) is not a mismatch; a booked line must equal its plan.
              matches: allocated === null || booked === 0n || booked === allocated,
            };
          })
          .sort((a, b) => a.department.localeCompare(b.department)),
      };
    })
    .sort((a, b) => a.purchaseId.localeCompare(b.purchaseId));
}

export function byDepartment(rows: readonly AllocationBreakdown[]): DepartmentBreakdown[] {
  const groups = new Map<string, DepartmentBreakdown>();
  for (const r of rows) {
    const booked = BigInt(r.bookedAtomic);
    if (booked === 0n) continue;
    const g = groups.get(r.department) ?? { department: r.department, bookedAtomic: 0n, purchases: [] };
    g.bookedAtomic += booked;
    g.purchases.push({ purchaseId: r.purchaseId, bookedAtomic: booked, merged: r.purchaseGroupId !== null });
    groups.set(r.department, g);
  }
  return [...groups.values()].sort((a, b) => a.department.localeCompare(b.department));
}
