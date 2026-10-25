import type { Hex } from "viem";

/**
 * The treasury (OpenZeppelin ECDSA) and USDC (ECRecover) accept only a 65-byte `r || s || v` signature with
 * `v in {27, 28}` and a low `s`. viem's recovery is more lenient (it also takes `v` as 0/1), so a signature that
 * recovers in TypeScript can still revert on chain. Every signature from a remote signer passes through here.
 */

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = SECP256K1_N >> 1n;

export class SignatureFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureFormatError";
  }
}

export interface SignatureInspection {
  /** Byte length of the raw signature. */
  bytes: number;
  /** The raw last byte (0, 1, 27 or 28 for a plain ECDSA signature). */
  vByte: number | null;
  lowS: boolean | null;
  /** True when the raw signature is already what the chain accepts. */
  canonical: boolean;
}

/** Describe a raw signature without judging it; the check script prints this. */
export function inspectSignature(raw: string): SignatureInspection {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  const wellFormed = /^[0-9a-fA-F]*$/.test(hex) && hex.length % 2 === 0;
  const bytes = wellFormed ? hex.length / 2 : -1;
  if (!wellFormed || bytes !== 65) return { bytes, vByte: null, lowS: null, canonical: false };
  const s = BigInt(`0x${hex.slice(64, 128)}`);
  const vByte = Number.parseInt(hex.slice(128, 130), 16);
  const lowS = s <= HALF_N;
  return { bytes, vByte, lowS, canonical: lowS && (vByte === 27 || vByte === 28) };
}

/**
 * Return the signature the chain accepts: 65 bytes, `v` 27/28 (0/1 is lifted by 27), `s` in the low half.
 * Throws instead of repairing anything else: a high-`s` or odd-length signature is not ours to fix.
 */
export function normalizeEcdsaSignature(raw: string): Hex {
  const info = inspectSignature(raw);
  if (info.bytes !== 65) {
    throw new SignatureFormatError(`expected a 65-byte ECDSA signature (r || s || v), got ${info.bytes < 0 ? "non-hex input" : `${info.bytes} bytes`}`);
  }
  if (info.lowS === false) throw new SignatureFormatError("signature has a high s value; the chain rejects it (EIP-2 / OpenZeppelin ECDSA)");
  const v = info.vByte;
  if (v === 27 || v === 28) return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (v === 0 || v === 1) {
    const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
    return `0x${hex.slice(0, 128)}${(v + 27).toString(16)}` as Hex;
  }
  throw new SignatureFormatError(`signature v byte is ${v}; expected 0, 1, 27 or 28`);
}
