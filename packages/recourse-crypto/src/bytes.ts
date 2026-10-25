import { bytesToBigInt, bytesToHex, hexToBytes, isHex, numberToBytes, type Hex } from "viem";

// ---------------------------------------------------------------------------
// Byte helpers. Public interfaces take Uint8Array or 0x-hex, never Buffer.
// ---------------------------------------------------------------------------

export const MAX_UINT64 = (1n << 64n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;

/** Accepts a Uint8Array or even-length 0x-hex string and returns bytes. */
export function toBytes(input: Hex | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (typeof input !== "string" || !isHex(input, { strict: true }) || input.length % 2 !== 0) {
    throw new Error("expected a Uint8Array or even-length 0x-prefixed hex string");
  }
  return hexToBytes(input);
}

export function toHexString(bytes: Uint8Array): Hex {
  return bytesToHex(bytes);
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) throw new Error(`xor length mismatch: ${a.length} vs ${b.length}`);
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] as number) ^ (b[i] as number);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** uint256 as 32 big-endian bytes (abi.encodePacked(uint256)). */
export function uint256Bytes(n: bigint | number): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v > MAX_UINT256) throw new Error("value out of uint256 range");
  return numberToBytes(v, { size: 32 });
}

/** uint64 as 8 big-endian bytes. */
export function uint64Bytes(n: bigint | number): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v > MAX_UINT64) throw new Error("value out of uint64 range");
  return numberToBytes(v, { size: 8 });
}

export function bytesToUint64(bytes: Uint8Array): bigint {
  if (bytes.length !== 8) throw new Error("expected 8 bytes");
  return bytesToBigInt(bytes);
}

export function assertLength(bytes: Uint8Array, expected: number, what: string): void {
  if (bytes.length !== expected) throw new Error(`${what} must be ${expected} bytes, got ${bytes.length}`);
}
