import { z } from "zod";

export const PACKAGE_NAME = "@overflow/schemas" as const;

/** Base Sepolia chain id. */
export const CHAIN_ID = 84532 as const;

/** USDC has 6 decimals; money is always integer atomic units. */
export const USDC_DECIMALS = 6 as const;

/** 0x-prefixed, 20-byte hex address. */
export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed 20-byte hex address");

/** Integer atomic units as a decimal string (never a float). */
export const AtomicAmountSchema = z
  .string()
  .regex(/^\d+$/, "expected non-negative integer decimal string");

export type Address = z.infer<typeof AddressSchema>;
export type AtomicAmount = z.infer<typeof AtomicAmountSchema>;
