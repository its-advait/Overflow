import { toAtomic, type Address } from "@overflow/schemas";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// SIMULATED direct x402 API prices (docs/SPEC.md Armadin table; Leash seller
// parity). Integer atomic units, never floats.
// ---------------------------------------------------------------------------

/** GET /api/search */
export const SEARCH_PRICE_ATOMIC = toAtomic("0.02");
/** GET /api/scrape */
export const SCRAPE_PRICE_ATOMIC = toAtomic("0.05");
/** GET /premium-intel (payTo = the SIMULATED attacker, never allowlisted) */
export const PREMIUM_INTEL_PRICE_ATOMIC = toAtomic("0.05");
/** The mismatched-quote fixture asks this many times the listed search price. */
export const MISMATCH_MULTIPLIER = 3n;
/** x402 maxTimeoutSeconds every route advertises. */
export const QUOTE_TIMEOUT_SECONDS = 120;
/** Request header a client sets to broadcast a settle() the simulation says will revert (DEMO_MODE only). */
export const FORCE_BROADCAST_HEADER = "x-overflow-force-broadcast";

/** Address of a label-derived SIMULATED key; nobody holds these keys for real. */
export function simulatedAddress(label: string): Address {
  return privateKeyToAccount(keccak256(toBytes(label))).address;
}

/** SIMULATED payee the mismatched-quote fixture names instead of the listed one. */
export const DECOY_PAYEE: Address = simulatedAddress("overflow.simulated.decoy-payee");
