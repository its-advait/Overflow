import { toAtomic, type Coverage, type License } from "@overflow/schemas";
import { STATES, type RowSpec, type StateCode } from "./rows";

// ---------------------------------------------------------------------------
// The SIMULATED catalog, designed so each Oracle and Fusion rule has a listing
// that fails exactly that rule (docs/SPEC.md "Fusion" > Merge rules; "Oracle" >
// Coverage filter). Prices come from the build prompt.
// ---------------------------------------------------------------------------

/** When the simulated feed was last refreshed (data through 2026-09). */
export const CATALOG_AS_OF = "2026-10-15";
export const DATASETS_DIR = "datasets";

export const SELLERS = {
  a: { id: "sim-seller-a", name: "SIMULATED seller A (Registry Data Co.)" },
  b: { id: "sim-seller-b", name: "SIMULATED seller B (Mobility Insights)" },
} as const;

export interface DatasetSpec {
  /** Also the directory name under data/datasets. */
  productId: string;
  title: string;
  rows: RowSpec;
}

const ALL_STATES: readonly StateCode[] = STATES;

export const DATASETS: readonly DatasetSpec[] = [
  {
    productId: "ev-registrations-national-monthly-2024-2026",
    title: "SIMULATED EV registrations, US national with state detail, monthly, 2024-01 to 2026-09",
    rows: { granularity: "monthly", startMonth: "2024-01", endMonth: "2026-09", states: ALL_STATES },
  },
  {
    productId: "ev-registrations-california-monthly-2024-2026",
    title: "SIMULATED EV registrations, California only, monthly, 2024-01 to 2026-09",
    rows: { granularity: "monthly", startMonth: "2024-01", endMonth: "2026-09", states: ["CA"] },
  },
  {
    productId: "ev-registrations-national-annual-2024-2026",
    title: "SIMULATED EV registrations, US national with state detail, annual (2026 year-to-date through September)",
    rows: { granularity: "annual", startMonth: "2024-01", endMonth: "2026-09", states: ALL_STATES },
  },
  {
    productId: "ev-registrations-national-monthly-2021-2022",
    title: "SIMULATED EV registrations, US national with state detail, monthly, 2021-01 to 2022-12",
    rows: { granularity: "monthly", startMonth: "2021-01", endMonth: "2022-12", states: ALL_STATES },
  },
];

export interface ListingSpec {
  id: string;
  sellerId: string;
  productId: string;
  title: string;
  license: License;
  seats: number;
  /** Human USDC amount, converted with toAtomic (never a float). */
  priceUsdc: string;
  /** Why this listing exists in the demo catalog. */
  exercises: string;
}

export const LISTINGS: readonly ListingSpec[] = [
  {
    id: "listing-national-monthly-2024-2026",
    sellerId: SELLERS.a.id,
    productId: "ev-registrations-national-monthly-2024-2026",
    title: "SIMULATED: US EV registrations, monthly, state detail, 2024-2026 (company-use)",
    license: "company-use",
    seats: 10,
    priceUsdc: "12",
    exercises: "Satisfies both Fusion example agents: national, monthly, 2024-2026, state detail, company-use.",
  },
  {
    id: "listing-california-monthly-2024-2026",
    sellerId: SELLERS.a.id,
    productId: "ev-registrations-california-monthly-2024-2026",
    title: "SIMULATED: California EV registrations, monthly, 2024-2026 (company-use)",
    license: "company-use",
    seats: 10,
    priceUsdc: "5",
    exercises: "Geography: fails the agent that needs the United States.",
  },
  {
    id: "listing-national-annual-2024-2026",
    sellerId: SELLERS.a.id,
    productId: "ev-registrations-national-annual-2024-2026",
    title: "SIMULATED: US EV registrations, annual, state detail, 2024-2026 (company-use)",
    license: "company-use",
    seats: 10,
    priceUsdc: "6",
    exercises: "Resolution: annual cannot roll down to monthly or quarterly.",
  },
  {
    id: "listing-national-monthly-2021-2022",
    sellerId: SELLERS.a.id,
    productId: "ev-registrations-national-monthly-2021-2022",
    title: "SIMULATED: US EV registrations, monthly, state detail, 2021-2022 (company-use)",
    license: "company-use",
    seats: 10,
    priceUsdc: "4",
    exercises: "Dates: wrong period; Oracle's coverage filter must reject it even though it is the cheapest.",
  },
  {
    id: "listing-national-monthly-2024-2026-seller-b",
    sellerId: SELLERS.b.id,
    productId: "ev-registrations-national-monthly-2024-2026",
    title: "SIMULATED: US EV registrations, monthly, state detail, 2024-2026 (company-use, seller B)",
    license: "company-use",
    seats: 10,
    priceUsdc: "13",
    exercises: "Duplicate of the national monthly set from a second seller; same manifestHash, higher price, so ranking prefers seller A.",
  },
  {
    id: "listing-national-monthly-2024-2026-single-user",
    sellerId: SELLERS.a.id,
    productId: "ev-registrations-national-monthly-2024-2026",
    title: "SIMULATED: US EV registrations, monthly, state detail, 2024-2026 (single-user license)",
    license: "single-user",
    seats: 1,
    priceUsdc: "10",
    exercises: "License: single-user, one seat; Fusion must not merge two agents onto it.",
  },
];

export function datasetSpec(productId: string): DatasetSpec {
  const d = DATASETS.find((x) => x.productId === productId);
  if (!d) throw new Error(`unknown dataset ${productId}`);
  return d;
}

/** Region codes: `US` for a national listing plus `US-<state>` for every state in the rows. */
export function regionsFor(rows: RowSpec): string[] {
  const states = [...rows.states].sort((a, b) => STATES.indexOf(a) - STATES.indexOf(b)).map((s) => `US-${s}`);
  return rows.states.length === STATES.length ? ["US", ...states] : states;
}

export function lastDayOfMonth(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${period}-${String(last).padStart(2, "0")}`;
}

export function coverageFor(spec: DatasetSpec, fields: string[]): Coverage {
  return {
    regions: regionsFor(spec.rows),
    dateRange: { start: `${spec.rows.startMonth}-01`, end: lastDayOfMonth(spec.rows.endMonth) },
    granularity: spec.rows.granularity,
    fields,
    format: "csv",
    asOf: CATALOG_AS_OF,
  };
}

export function priceAtomicFor(listing: ListingSpec): string {
  return toAtomic(listing.priceUsdc);
}
