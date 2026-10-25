import { encodePacked, keccak256, stringToHex } from "viem";
import type { Granularity } from "@overflow/schemas";

// ---------------------------------------------------------------------------
// SIMULATED EV registration rows. Every number is a pure function of
// (state, period, brand): base volume x brand share x growth, plus keccak
// "noise". No PRNG sequence and no floats, so regeneration is byte-identical,
// a California file equals the national file's CA rows, and annual rows are
// exact sums of monthly rows.
// ---------------------------------------------------------------------------

export const GENERATOR_SEED = "overflow.simulated.ev-registrations.v1";

/** Two-letter state codes present in the simulated feed. Region code = `US-<state>`. */
export const STATES = ["CA", "TX", "FL", "NY", "WA", "NJ", "IL", "GA"] as const;
export type StateCode = (typeof STATES)[number];

/** Fictional brands; no real manufacturer is named. */
export const BRANDS = ["Voltara", "Kestrel"] as const;
export type Brand = (typeof BRANDS)[number];

/** Label column present in every row so a decrypted sample is self-describing. */
export const SIMULATED_COLUMN = "simulated";
export const MONTHLY_FIELDS = ["month", "state", "brand", "units"] as const;
export const ANNUAL_FIELDS = ["year", "state", "brand", "units"] as const;
export const MONTHLY_HEADER = [...MONTHLY_FIELDS, SIMULATED_COLUMN].join(",");
export const ANNUAL_HEADER = [...ANNUAL_FIELDS, SIMULATED_COLUMN].join(",");

/** Monthly registrations in January 2024 per state (simulated scale, integer units). */
const BASE_UNITS: Readonly<Record<StateCode, number>> = {
  CA: 14000,
  TX: 6200,
  FL: 5400,
  NY: 3900,
  WA: 3100,
  NJ: 2600,
  IL: 2300,
  GA: 2100,
};

/** Brand share in basis points; sums to 10000. */
const BRAND_SHARE_BPS: Readonly<Record<Brand, number>> = { Voltara: 6200, Kestrel: 3800 };

/** Index base: months since 2024-01 (negative for 2021-2022). */
const GROWTH_ORIGIN = { year: 2024, month: 1 };
/** Growth per month in basis points (about 1.2% a month), applied linearly in integers. */
const GROWTH_BPS_PER_MONTH = 120;
/** Seasonal bump in basis points by calendar month (Mar, Jun, Sep, Dec quarter-ends run hot). */
const SEASONAL_BPS: readonly number[] = [-600, -400, 500, 0, 100, 600, -200, 0, 700, 100, -300, 900];
/** Noise range in basis points, symmetric around zero. */
const NOISE_BPS = 800;

export interface Month {
  year: number;
  month: number; // 1..12
}

export function parseMonth(period: string): Month {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error(`bad month "${period}", expected YYYY-MM`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`bad month "${period}"`);
  return { year, month };
}

export function formatMonth({ year, month }: Month): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Inclusive list of months from `start` to `end` (both YYYY-MM). */
export function monthsBetween(start: string, end: string): string[] {
  const s = parseMonth(start);
  const e = parseMonth(end);
  const out: string[] = [];
  for (let y = s.year, m = s.month; y < e.year || (y === e.year && m <= e.month); ) {
    out.push(formatMonth({ year: y, month: m }));
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  if (out.length === 0) throw new Error(`empty month range ${start}..${end}`);
  return out;
}

/** Unix seconds (UTC) of the first second of the month after `period`: when the registry would publish it. */
export function publicationTimestamp(period: string): bigint {
  const { year, month } = parseMonth(period);
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return BigInt(Date.UTC(next.year, next.month - 1, 1)) / 1000n;
}

function monthIndex(period: string): number {
  const { year, month } = parseMonth(period);
  return (year - GROWTH_ORIGIN.year) * 12 + (month - GROWTH_ORIGIN.month);
}

/** keccak-derived integer in [-NOISE_BPS, NOISE_BPS], a pure function of the row key. */
function noiseBps(state: StateCode, period: string, brand: Brand): number {
  const digest = keccak256(
    encodePacked(["bytes", "bytes", "bytes", "bytes"], [stringToHex(GENERATOR_SEED), stringToHex(state), stringToHex(period), stringToHex(brand)]),
  );
  const span = BigInt(2 * NOISE_BPS + 1);
  return Number(BigInt(digest) % span) - NOISE_BPS;
}

/** Simulated registrations for one (state, month, brand). Always a non-negative integer. */
export function monthlyUnits(state: StateCode, period: string, brand: Brand): number {
  const idx = monthIndex(period);
  const growthBps = 10000 + GROWTH_BPS_PER_MONTH * idx;
  const seasonal = SEASONAL_BPS[parseMonth(period).month - 1] as number;
  const factorBps = Math.max(1000, growthBps + seasonal + noiseBps(state, period, brand));
  const base = BASE_UNITS[state] * BRAND_SHARE_BPS[brand];
  // base is units x bps; divide by 10000 (share) and 10000 (factor) using integer math.
  return Math.floor((base * factorBps) / 100_000_000);
}

export interface RowSpec {
  granularity: Extract<Granularity, "monthly" | "annual">;
  /** Inclusive month range, YYYY-MM. Annual rows sum the months of each year present. */
  startMonth: string;
  endMonth: string;
  states: readonly StateCode[];
  brands?: readonly Brand[];
}

export interface DataRow {
  /** YYYY-MM for monthly, YYYY for annual. */
  period: string;
  state: StateCode;
  brand: Brand;
  units: number;
  /** Last month the row aggregates (for annual rows, the last month of that year within the range). */
  lastMonth: string;
}

/** Rows sorted by period, state (in STATES order), brand (in BRANDS order). */
export function buildRows(spec: RowSpec): DataRow[] {
  const brands = spec.brands ?? BRANDS;
  const months = monthsBetween(spec.startMonth, spec.endMonth);
  const states = [...spec.states].sort((a, b) => STATES.indexOf(a) - STATES.indexOf(b));
  const rows: DataRow[] = [];
  if (spec.granularity === "monthly") {
    for (const period of months) {
      for (const state of states) {
        for (const brand of brands) rows.push({ period, state, brand, units: monthlyUnits(state, period, brand), lastMonth: period });
      }
    }
    return rows;
  }
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];
  for (const year of years) {
    const yearMonths = months.filter((m) => m.startsWith(year));
    for (const state of states) {
      for (const brand of brands) {
        const units = yearMonths.reduce((sum, m) => sum + monthlyUnits(state, m, brand), 0);
        rows.push({ period: year, state, brand, units, lastMonth: yearMonths[yearMonths.length - 1] as string });
      }
    }
  }
  return rows;
}

export function headerFor(granularity: RowSpec["granularity"]): string {
  return granularity === "monthly" ? MONTHLY_HEADER : ANNUAL_HEADER;
}

export function fieldsFor(granularity: RowSpec["granularity"]): string[] {
  return granularity === "monthly" ? [...MONTHLY_FIELDS] : [...ANNUAL_FIELDS];
}

/** One CSV line: period,state,brand,units,simulated. */
export function formatRow(row: DataRow): string {
  return [row.period, row.state, row.brand, String(row.units), SIMULATED_COLUMN].join(",");
}
