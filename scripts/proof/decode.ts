import { overflowEscrowAbi, overflowEscrowFactoryAbi } from "@overflow/schemas";
import { decodeErrorResult, getAddress, isHex, type Hex } from "viem";
import { decodeRevertData } from "../../apps/service/src/facilitator/decode.js";

// ---------------------------------------------------------------------------
// Revert decoding for the proof. Treasury custom errors and USDC's
// Error(string) go through the service's own decoder (facilitator/decode.ts);
// escrow and factory errors fall back to the generated ABIs. Arguments are
// decimal strings or checksummed addresses, never floats.
// ---------------------------------------------------------------------------

export interface DecodedError {
  name: string;
  args: string[];
}

export const formatError = (e: DecodedError): string => `${e.name}(${e.args.map((a) => (e.name === "Error" ? JSON.stringify(a) : a)).join(",")})`;

function fmtArg(a: unknown): string {
  if (typeof a === "bigint") return a.toString();
  if (typeof a === "number") return String(a);
  if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) return getAddress(a);
  return String(a);
}

/** Raw revert bytes -> error name and args, across treasury, USDC, escrow and factory. */
export function decodeRevertBytes(data: Hex): DecodedError | undefined {
  if (!isHex(data) || data.length < 10) return undefined;
  const service = decodeRevertData(data);
  if (service) return { name: service.name, args: service.args };
  for (const abi of [overflowEscrowAbi, overflowEscrowFactoryAbi]) {
    try {
      const r = decodeErrorResult({ abi, data });
      return { name: r.errorName, args: ((r.args ?? []) as readonly unknown[]).map(fmtArg) };
    } catch {
      /* not this contract's error */
    }
  }
  return undefined;
}

/** Walks a viem error (and its causes) for revert data or an already-decoded error. */
export function decodeError(err: unknown): DecodedError | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 12 && cur && typeof cur === "object"; i++) {
    const o = cur as { data?: unknown; raw?: unknown; cause?: unknown; reason?: unknown };
    const d = o.data;
    if (d && typeof d === "object" && typeof (d as { errorName?: unknown }).errorName === "string") {
      const name = (d as { errorName: string }).errorName;
      const args = (((d as { args?: unknown }).args as readonly unknown[] | undefined) ?? []).map(fmtArg);
      return { name, args };
    }
    for (const candidate of [d, o.raw, d && typeof d === "object" ? (d as { data?: unknown }).data : undefined]) {
      if (typeof candidate === "string" && isHex(candidate)) {
        const decoded = decodeRevertBytes(candidate);
        if (decoded) return decoded;
      }
    }
    cur = o.cause;
  }
  return undefined;
}

/** "PayeeNotAllowed(0)", "Error(\"FiatTokenV2: invalid signature\")" or "OverBudget(5)" -> name and args. */
export function parseDecoded(text: string): DecodedError | undefined {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/s.exec(text.trim());
  if (!m) return undefined;
  const name = m[1]!;
  const inner = m[2]!.trim();
  if (inner === "") return { name, args: [] };
  if (name === "Error") {
    try {
      return { name, args: [JSON.parse(inner) as string] };
    } catch {
      return { name, args: [inner] };
    }
  }
  return { name, args: inner.split(",").map((s) => s.trim()) };
}

/** Same error name and exactly the same arguments (addresses compared case-insensitively). */
export function sameError(actual: DecodedError | undefined, expected: DecodedError): boolean {
  if (!actual || actual.name !== expected.name) return false;
  if (actual.args.length !== expected.args.length) return false;
  return expected.args.every((a, i) => a.toLowerCase() === (actual.args[i] ?? "").toLowerCase());
}
