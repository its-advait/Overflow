import { AtomicAmountSchema, atomicToBigInt, bigIntToAtomic, type Allocation } from "@overflow/schemas";

// ---------------------------------------------------------------------------
// Subledger allocations: integer atomic shares that sum exactly to the price
// (largest-remainder rounding). Each child's onchain cap is untouched; these
// are ledger lines tagged with the agent's department. bigint only, no floats.
// ---------------------------------------------------------------------------

export interface Share {
  agentId: string;
  department: string;
  /** Relative weight (e.g. the agent's max price); non-negative, at least one positive. */
  weight: bigint | string;
}

export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationError";
  }
}

const toWeight = (w: bigint | string): bigint => {
  const v = typeof w === "bigint" ? w : BigInt(AtomicAmountSchema.parse(w));
  if (v < 0n) throw new AllocationError(`negative weight ${v}`);
  return v;
};

/** Splits `priceAtomic` across `shares` by weight; the result sums exactly to the price. Output keeps input order. */
export function allocate(priceAtomic: string | bigint, shares: readonly Share[]): Allocation[] {
  if (shares.length === 0) throw new AllocationError("allocate needs at least one share");
  const price = atomicToBigInt(priceAtomic);
  const weights = shares.map((s) => toWeight(s.weight));
  const total = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n) throw new AllocationError("all weights are zero");

  const floors = weights.map((w) => (price * w) / total);
  const remainders = weights.map((w) => (price * w) % total);
  let leftover = price - floors.reduce((a, b) => a + b, 0n);

  // Largest remainder first; ties by agentId, then input order, so the split never depends on input order alone.
  const order = shares
    .map((s, i) => i)
    .sort((i, j) => {
      if (remainders[i] !== remainders[j]) return remainders[i]! > remainders[j]! ? -1 : 1;
      const a = shares[i]!.agentId;
      const b = shares[j]!.agentId;
      return a < b ? -1 : a > b ? 1 : i - j;
    });
  for (const i of order) {
    if (leftover === 0n) break;
    floors[i] = floors[i]! + 1n;
    leftover -= 1n;
  }

  const sum = floors.reduce((a, b) => a + b, 0n);
  if (sum !== price) throw new AllocationError(`allocations sum to ${sum}, price is ${price}`);
  return shares.map((s, i) => ({ agentId: s.agentId, department: s.department, amountAtomic: bigIntToAtomic(floors[i]!) }));
}
