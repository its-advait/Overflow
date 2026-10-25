import type { Address, Hex } from "viem";
import { z } from "zod";

/** USDC has 6 decimals; money is always integer atomic units. */
export const USDC_DECIMALS = 6 as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const UINT_RE = /^(0|[1-9]\d*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;

/** 0x-prefixed, 20-byte hex address. Input and output type are both viem `Address`. */
export const AddressSchema = z.custom<Address>(
  (v) => typeof v === "string" && ADDRESS_RE.test(v),
  "expected 0x-prefixed 20-byte hex address",
);

/** 0x-prefixed, 32-byte hex (hashes, digests, nonces, salts). */
export const Bytes32Schema = z.custom<Hex>(
  (v) => typeof v === "string" && BYTES32_RE.test(v),
  "expected 0x-prefixed 32-byte hex",
);

/** 0x-prefixed, even-length hex of any byte length (signatures, calldata). */
export const HexSchema = z.custom<Hex>(
  (v) => typeof v === "string" && HEX_RE.test(v),
  "expected 0x-prefixed even-length hex",
);

/**
 * Non-negative integer as a decimal string, at most uint256.
 * No leading zeros, sign, decimal point or exponent. Never a float.
 */
export const UintStringSchema = z
  .string()
  .regex(UINT_RE, "expected non-negative integer decimal string")
  // Zod 4 runs later checks even after the regex fails, so guard before BigInt().
  .refine((v) => !UINT_RE.test(v) || BigInt(v) <= MAX_UINT256, "exceeds uint256");

/** Integer atomic USDC units (6 decimals) as a decimal string. */
export const AtomicAmountSchema = UintStringSchema;

/** ISO-8601 date-time with offset, e.g. 2026-10-24T16:00:00Z. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** ISO-8601 calendar date, e.g. 2026-10-24. */
export const IsoDateSchema = z.iso.date();

/** Opaque offchain identifier (uuid or slug). */
export const IdSchema = z.string().min(1);

export type { Address, Hex };
export type Bytes32 = z.infer<typeof Bytes32Schema>;
export type UintString = z.infer<typeof UintStringSchema>;
export type AtomicAmount = z.infer<typeof AtomicAmountSchema>;
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
export type IsoDate = z.infer<typeof IsoDateSchema>;
export type Id = z.infer<typeof IdSchema>;
