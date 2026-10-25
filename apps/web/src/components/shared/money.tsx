import { formatUsdc, type AtomicAmount } from "@overflow/schemas";
import { cn } from "@/lib/utils";

type Size = "sm" | "md" | "lg" | "xl";

const SIZES: Record<Size, { num: string; unit: string }> = {
  sm: { num: "text-sm font-medium", unit: "text-[10px]" },
  md: { num: "text-base font-medium", unit: "text-[11px]" },
  lg: { num: "text-2xl font-semibold tracking-tight", unit: "text-xs" },
  xl: { num: "text-4xl font-semibold tracking-tight", unit: "text-sm" },
};

/**
 * Formats integer atomic USDC (6 decimals) with `formatUsdc`; no floats anywhere.
 * Accepts the unsigned AtomicAmount strings the schemas use, a bigint, or the
 * signed decimal strings the ledger's net balances carry.
 */
export function Money({
  atomic,
  size = "md",
  signed = false,
  muted = false,
  unit = "USDC",
  className,
}: {
  atomic: AtomicAmount | bigint;
  size?: Size;
  /** Show a leading + for positive values; negatives always show a minus. */
  signed?: boolean;
  muted?: boolean;
  unit?: string | null;
  className?: string;
}) {
  const value = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const sign = negative ? "−" : signed && value > 0n ? "+" : "";
  const text = withGroups(formatUsdc(magnitude));
  const s = SIZES[size];
  return (
    <span
      className={cn(
        "tnum inline-flex items-baseline gap-1",
        negative ? "text-danger" : muted ? "text-text-muted" : "text-text",
        className,
      )}
      aria-label={`${sign}${text} ${unit ?? ""}`.trim()}
    >
      <span className={s.num}>
        {sign}
        {text}
      </span>
      {unit ? <span className={cn("font-medium uppercase tracking-wider text-text-muted", s.unit)}>{unit}</span> : null}
    </span>
  );
}

/** Thousands separators on the integer part only; string work, never Number(). */
function withGroups(formatted: string): string {
  const [int = "", frac] = formatted.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac !== undefined ? `${grouped}.${frac}` : grouped;
}
