import { BaseError, ContractFunctionRevertedError, decodeErrorResult, getAddress, type Hex } from "viem";
import { overflowTreasuryAbi } from "@overflow/schemas";

/** A revert made readable for the Blocked lane. `args` are decimal strings or checksummed addresses, never floats. */
export type Decoded = {
  name: string;
  args: string[];
  reason: string;
  selector?: Hex;
  source: "treasury" | "usdc" | "evm" | "unknown";
};

/** Treasury custom errors (docs/SPEC.md Blocked-lane table plus the P1.4–P1.7 additions). */
export const TREASURY_REASONS: Record<string, (args: string[]) => string> = {
  UnknownAgent: ([s]) => `Signed by ${s}, which is not a registered agent key`,
  PayeeNotAllowed: ([n]) => (n === "0" ? "Recipient is not approved for anyone" : `Recipient is not approved for agent ${n}`),
  OverPerCall: ([n]) => `Single payment above agent ${n}'s per-call limit`,
  OverBudget: ([n]) => `Agent ${n} or an ancestor would pass its cap`,
  Expired: ([n]) => `Agent ${n}'s authority has expired`,
  Paused: ([n]) => `Agent ${n} is paused`,
  BelowFloor: () => "Payment would drop the treasury under its floor (reservations count)",
  TooDeep: () => "Delegation tree is too deep (max 3 levels)",
  ChildExceedsParent: () => "Child would have more authority than its parent",
  BadDelegation: () => "Delegation signature invalid, expired, already used or from the wrong key",
  KeyInUse: () => "Key is already a node, the owner, the treasury or zero",
  NotAncestor: () => "Signer is not a strict ancestor of the target node",
  NotOwner: () => "Only the treasury owner (controller) can do that",
  PayeeFlagged: ([s]) => `Seller ${s} has a proven cheat on record`,
  EscrowAmountMismatch: ([e, exp, act]) => `Escrow ${e} expects exactly ${exp} atomic USDC, authorization is for ${act}`,
  EscrowClosed: ([e]) => `Escrow ${e} is already settled or refunded`,
  ReservationTooLong: () => "validBefore is beyond the reservation window",
  ReservationActive: () => "This authorization is already reserved",
  NoReservation: () => "No reservation exists for this digest",
  ReservationLive: () => "Reservation has not reached validBefore yet",
  NotEscrowReservation: () => "Reservation pays a direct payee; only a reservation to an escrow can be released early",
  EscrowStillOpen: ([e]) => `Escrow ${e} has not settled or refunded yet`,
  AuthorizationUsed: () => "USDC already executed this authorization; it releases without a refund after validBefore",
  ECDSAInvalidSignature: () => "Malformed signature",
  ECDSAInvalidSignatureLength: ([l]) => `Malformed signature (length ${l})`,
  ECDSAInvalidSignatureS: () => "Malformed signature (high s)",
  ReentrancyGuardReentrantCall: () => "Reentrant call rejected",
  SafeERC20FailedOperation: ([t]) => `Token ${t} rejected the transfer`,
  SafeERC20FailedDecreaseAllowance: ([sp]) => `Allowance decrease for ${sp} failed`,
  AddressEmptyCode: ([a]) => `No contract at ${a}`,
  AddressInsufficientBalance: ([a]) => `Insufficient ETH balance at ${a}`,
  FailedInnerCall: () => "Inner call failed",
  FailedCall: () => "Inner call failed",
};

/** USDC (FiatTokenV2.2) Error(string) messages -> plain reasons. Matched by prefix. */
export const USDC_REASONS: ReadonlyArray<[match: string, reason: string]> = [
  ["FiatTokenV2: invalid signature", "USDC rejected the signature: it is only valid inside treasury.settle() or a live reservation"],
  ["FiatTokenV2: authorization is used or canceled", "Authorization already used or canceled"],
  ["FiatTokenV2: authorization is not yet valid", "Authorization not yet valid (validAfter in the future)"],
  ["FiatTokenV2: authorization is expired", "Authorization expired (validBefore passed)"],
  ["FiatTokenV2: caller must be the payee", "Only the payee may submit this authorization"],
  ["Blacklistable: account is blacklisted", "Circle has blacklisted an account in this transfer"],
  ["Pausable: paused", "USDC is paused"],
  ["ERC20: transfer amount exceeds balance", "Treasury USDC balance too low"],
  ["FiatToken: transfer to the zero address", "Transfer to the zero address"],
];

export const BYPASS_REASON: string = USDC_REASONS[0]![1];

const ERROR_STRING_ABI = [{ type: "error", name: "Error", inputs: [{ type: "string", name: "message" }] }] as const;
const PANIC_ABI = [{ type: "error", name: "Panic", inputs: [{ type: "uint256", name: "code" }] }] as const;

function fmtArg(a: unknown): string {
  if (typeof a === "bigint") return a.toString();
  if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) return getAddress(a);
  if (typeof a === "boolean") return a ? "true" : "false";
  return String(a);
}

function fromName(name: string, rawArgs: readonly unknown[] | undefined, selector?: Hex): Decoded {
  const args = (rawArgs ?? []).map(fmtArg);
  const reason = TREASURY_REASONS[name]?.(args) ?? name;
  return { name, args, reason, source: "treasury", ...(selector ? { selector } : {}) };
}

export function usdcReason(message: string): string {
  for (const [m, r] of USDC_REASONS) if (message.startsWith(m)) return r;
  return `USDC reverted: ${message}`;
}

/** Decode raw revert data (custom error, Error(string) or Panic). Returns undefined for data we cannot read. */
export function decodeRevertData(data: Hex): Decoded | undefined {
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data)) return undefined;
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  try {
    if (selector === "0x08c379a0") {
      const r = decodeErrorResult({ abi: ERROR_STRING_ABI, data });
      const message = String(r.args[0]);
      return { name: "Error", args: [message], reason: usdcReason(message), selector, source: "usdc" };
    }
    if (selector === "0x4e487b71") {
      const r = decodeErrorResult({ abi: PANIC_ABI, data });
      return { name: "Panic", args: [String(r.args[0])], reason: `EVM panic 0x${r.args[0].toString(16)}`, selector, source: "evm" };
    }
    const r = decodeErrorResult({ abi: overflowTreasuryAbi, data });
    return fromName(r.errorName, r.args as readonly unknown[] | undefined, selector);
  } catch {
    return undefined;
  }
}

function* causes(err: unknown): Generator<unknown> {
  let cur: unknown = err;
  for (let i = 0; i < 12 && cur !== null && typeof cur === "object"; i++) {
    yield cur;
    cur = (cur as { cause?: unknown }).cause;
  }
}

function collectHex(err: unknown): Hex[] {
  const out: Hex[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v)) out.push(v as Hex);
  };
  for (const c of causes(err)) {
    const o = c as Record<string, unknown>;
    push(o["data"]);
    if (o["data"] && typeof o["data"] === "object") push((o["data"] as Record<string, unknown>)["data"]);
    push(o["raw"]);
  }
  return out;
}

export function shortMessage(err: unknown, max = 300): string {
  const m = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
  return (m.split("\n")[0] ?? "").slice(0, max);
}

/** Decode any error thrown by viem (simulate/send/receipt) or a raw revert hex into a Decoded. Never throws. */
export function decodeRevert(err: unknown): Decoded {
  if (typeof err === "string") {
    return decodeRevertData(err as Hex) ?? { name: "Unknown", args: [], reason: err, source: "unknown" };
  }
  for (const c of causes(err)) {
    if (c instanceof ContractFunctionRevertedError) {
      if (c.data?.errorName) {
        const name = c.data.errorName;
        if (name === "Error") {
          const message = String(c.data.args?.[0] ?? c.reason ?? "");
          return { name, args: [message], reason: usdcReason(message), source: "usdc" };
        }
        if (name === "Panic") return { name, args: [String(c.data.args?.[0])], reason: "EVM panic", source: "evm" };
        return fromName(name, c.data.args as readonly unknown[] | undefined);
      }
      if (c.raw) {
        const d = decodeRevertData(c.raw);
        if (d) return d;
      }
      if (c.reason) return { name: "Error", args: [c.reason], reason: usdcReason(c.reason), source: "usdc" };
    }
  }
  for (const h of collectHex(err)) {
    const d = decodeRevertData(h);
    if (d) return d;
  }
  return { name: "Unknown", args: [], reason: shortMessage(err), source: "unknown" };
}
