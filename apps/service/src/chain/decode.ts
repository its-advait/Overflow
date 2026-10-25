import { decodeErrorResult, decodeEventLog, isHex, type Hex } from "viem";
import { EVENT_BY_TOPIC, REVERT_REASONS, treasuryAbi, type ContractKind, type IndexedEventName } from "./abi.js";
import type { RawLog } from "./log-source.js";

// ---------------------------------------------------------------------------
// Log and revert decoding. Args are serialized to JSON-safe values: bigints
// become decimal strings (never floats), addresses stay checksummed hex.
// ---------------------------------------------------------------------------

export type JsonArgs = Record<string, string | number | boolean>;

export interface DecodedLog {
  kind: ContractKind;
  eventName: IndexedEventName;
  args: JsonArgs;
  log: RawLog;
}

export function serializeArg(v: unknown): string | number | boolean {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  throw new TypeError(`unsupported event argument ${String(v)}`);
}

/** Decodes one raw log against the three ABIs; undefined when topic0 is not one of ours. */
export function decodeLog(log: RawLog): DecodedLog | undefined {
  const topic0 = log.topics[0];
  if (!topic0) return undefined;
  const hit = EVENT_BY_TOPIC.get(topic0);
  if (!hit) return undefined;
  const decoded = decodeEventLog({
    abi: [hit.event],
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
    strict: true,
  });
  const args: JsonArgs = {};
  for (const [k, v] of Object.entries(decoded.args as Record<string, unknown>)) args[k] = serializeArg(v);
  return { kind: hit.kind, eventName: decoded.eventName as IndexedEventName, args, log };
}

export interface DecodedRevert {
  /** Error name, "Error" for a USDC Error(string), "Unknown" when nothing decoded. */
  name: string;
  args: string[];
  /** Compact form for activity_events.decoded_revert, e.g. "OverBudget(3)". */
  decoded: string;
  /** What the Blocked lane shows. */
  reason: string;
}

function collectHex(err: unknown): Hex[] {
  const out: Hex[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  let depth = 0;
  while (cur && typeof cur === "object" && !seen.has(cur) && depth++ < 12) {
    seen.add(cur);
    const o = cur as { data?: unknown; raw?: unknown; cause?: unknown };
    if (typeof o.data === "string" && isHex(o.data) && o.data.length >= 10) out.push(o.data);
    if (o.data && typeof o.data === "object") {
      const inner = (o.data as { data?: unknown }).data;
      if (typeof inner === "string" && isHex(inner)) out.push(inner);
    }
    if (typeof o.raw === "string" && isHex(o.raw)) out.push(o.raw);
    cur = o.cause;
  }
  return out;
}

export function shortMessage(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage || e?.message || String(err)).split("\n")[0]!.slice(0, 300);
}

const format = (name: string, args: string[]): string => `${name}(${args.join(", ")})`;

/**
 * Decodes a treasury custom error (or USDC's Error(string)) out of a viem error
 * or raw revert data. Modeled on Leash's facilitator decode.ts.
 */
export function decodeTreasuryRevert(err: unknown): DecodedRevert {
  if (typeof err === "string" && isHex(err)) return decodeTreasuryRevert({ data: err });

  // viem already decoded it when the ABI it was given knew the error.
  let cur: unknown = err;
  for (let i = 0; cur && typeof cur === "object" && i < 12; i++) {
    const d = (cur as { data?: unknown }).data;
    if (d && typeof d === "object" && typeof (d as { errorName?: unknown }).errorName === "string") {
      const errorName = (d as { errorName: string }).errorName;
      const args = (((d as { args?: unknown }).args as readonly unknown[] | undefined) ?? []).map((a) => String(a));
      return { name: errorName, args, decoded: format(errorName, args), reason: REVERT_REASONS[errorName] ?? errorName };
    }
    cur = (cur as { cause?: unknown }).cause;
  }

  for (const data of collectHex(err)) {
    try {
      // viem also knows Solidity's built-in Error(string) and Panic(uint256).
      const r = decodeErrorResult({ abi: treasuryAbi, data }) as { errorName: string; args?: readonly unknown[] };
      const args = (r.args ?? []).map((a) => String(a));
      if (r.errorName === "Error") {
        const message = args[0] ?? "";
        return { name: "Error", args, decoded: `Error(${JSON.stringify(message)})`, reason: message };
      }
      if (r.errorName === "Panic") return { name: "Panic", args, decoded: format("Panic", args), reason: `Solidity panic ${args[0] ?? ""}` };
      return { name: r.errorName, args, decoded: format(r.errorName, args), reason: REVERT_REASONS[r.errorName] ?? r.errorName };
    } catch {
      /* not a treasury or Solidity error; try next */
    }
  }
  const msg = shortMessage(err);
  return { name: "Unknown", args: [], decoded: `Unknown(${JSON.stringify(msg)})`, reason: msg };
}
