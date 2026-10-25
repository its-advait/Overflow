import { AtomicAmountSchema, USDC_DECIMALS, type AtomicAmount } from "./primitives";

const HUMAN_RE = /^(\d+)(?:\.(\d+))?$/;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

export class MoneyFormatError extends Error {
  constructor(message: string, public readonly input: unknown) {
    super(message);
    this.name = "MoneyFormatError";
  }
}

/**
 * Parse a human USDC amount ("8.40") into integer atomic units ("8400000").
 * Pure string arithmetic; rejects anything that is not `digits[.digits]`
 * with at most 6 fractional digits. Never touches a float.
 */
export function toAtomic(human: string): AtomicAmount {
  if (typeof human !== "string") {
    throw new MoneyFormatError("amount must be a decimal string, not a number", human);
  }
  const m = HUMAN_RE.exec(human);
  if (!m) {
    throw new MoneyFormatError(`invalid USDC amount "${human}"`, human);
  }
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > USDC_DECIMALS) {
    throw new MoneyFormatError(
      `USDC has ${USDC_DECIMALS} decimals; "${human}" has ${frac.length}`,
      human,
    );
  }
  const atomic = BigInt(whole) * SCALE + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
  return atomic.toString(10);
}

/** AtomicAmount string -> bigint, validated. */
export function atomicToBigInt(atomic: AtomicAmount | bigint): bigint {
  if (typeof atomic === "bigint") {
    if (atomic < 0n) throw new MoneyFormatError("negative amount", atomic);
    return atomic;
  }
  return BigInt(AtomicAmountSchema.parse(atomic));
}

/** bigint -> AtomicAmount string, validated. */
export function bigIntToAtomic(value: bigint): AtomicAmount {
  return AtomicAmountSchema.parse(value.toString(10));
}

/** Sum of atomic amounts, as an AtomicAmount string. */
export function sumAtomic(amounts: readonly (AtomicAmount | bigint)[]): AtomicAmount {
  let total = 0n;
  for (const a of amounts) total += atomicToBigInt(a);
  return total.toString(10);
}

export interface FormatUsdcOptions {
  /** Trim trailing zeros down to `minFractionDigits` (default true). */
  trimZeros?: boolean;
  /** Minimum fractional digits kept when trimming (default 2). */
  minFractionDigits?: number;
}

/**
 * Format atomic units for display: "8400000" -> "8.40", "12000000" -> "12.00",
 * "1" -> "0.000001". Integer arithmetic only.
 */
export function formatUsdc(atomic: AtomicAmount | bigint, opts: FormatUsdcOptions = {}): string {
  const { trimZeros = true, minFractionDigits = 2 } = opts;
  const value = atomicToBigInt(atomic);
  const whole = (value / SCALE).toString(10);
  let frac = (value % SCALE).toString(10).padStart(USDC_DECIMALS, "0");
  if (trimZeros) {
    const min = Math.min(Math.max(minFractionDigits, 0), USDC_DECIMALS);
    while (frac.length > min && frac.endsWith("0")) frac = frac.slice(0, -1);
  }
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}
