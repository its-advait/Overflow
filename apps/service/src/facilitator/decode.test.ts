import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { overflowTreasuryAbi } from "@overflow/schemas";
import { BYPASS_REASON, decodeRevert, decodeRevertData, TREASURY_REASONS, USDC_REASONS } from "./decode";

const ERROR_ABI = [{ type: "error", name: "Error", inputs: [{ type: "string" }] }] as const;
const errorString = (m: string): Hex => encodeErrorResult({ abi: ERROR_ABI, args: [m] });
const A = "0x1111111111111111111111111111111111111111" as const;

/** Every custom error in the treasury ABI with sample args. */
const CASES: Array<{ name: string; args: unknown[]; reason: RegExp }> = [
  { name: "UnknownAgent", args: [A], reason: /not a registered agent/ },
  { name: "PayeeNotAllowed", args: [0n], reason: /not approved for anyone/ },
  { name: "PayeeNotAllowed", args: [3n], reason: /agent 3/ },
  { name: "OverPerCall", args: [2n], reason: /per-call/ },
  { name: "OverBudget", args: [1n], reason: /cap/ },
  { name: "Expired", args: [4n], reason: /expired/ },
  { name: "Paused", args: [5n], reason: /paused/ },
  { name: "BelowFloor", args: [], reason: /floor/ },
  { name: "TooDeep", args: [], reason: /deep/ },
  { name: "ChildExceedsParent", args: [], reason: /parent/ },
  { name: "BadDelegation", args: [], reason: /Delegation/ },
  { name: "KeyInUse", args: [], reason: /Key/ },
  { name: "NotAncestor", args: [], reason: /ancestor/ },
  { name: "NotOwner", args: [], reason: /owner/ },
  { name: "PayeeFlagged", args: [A], reason: /proven cheat/ },
  { name: "EscrowAmountMismatch", args: [A, 50000n, 49999n], reason: /exactly 50000.*49999/ },
  { name: "EscrowClosed", args: [A], reason: /settled or refunded/ },
  { name: "ReservationTooLong", args: [], reason: /window/ },
  { name: "ReservationActive", args: [], reason: /already reserved/ },
  { name: "NoReservation", args: [], reason: /No reservation/ },
  { name: "ReservationLive", args: [], reason: /validBefore/ },
  { name: "ECDSAInvalidSignature", args: [], reason: /Malformed/ },
  { name: "ECDSAInvalidSignatureLength", args: [64n], reason: /length 64/ },
  { name: "ECDSAInvalidSignatureS", args: [`0x${"ff".repeat(32)}`], reason: /high s/ },
  { name: "ReentrancyGuardReentrantCall", args: [], reason: /Reentrant/ },
];

describe("decodeRevertData: treasury custom errors", () => {
  it("covers every custom error in the ABI", () => {
    const abiErrors = overflowTreasuryAbi.filter((e) => e.type === "error").map((e) => e.name);
    for (const n of abiErrors) expect(TREASURY_REASONS[n], `reason for ${n}`).toBeDefined();
    for (const c of CASES) expect(abiErrors, `${c.name} in ABI`).toContain(c.name);
    const treasuryOwn = abiErrors.filter((n) => !/^(SafeERC20|Address|Failed)/.test(n));
    expect(new Set(CASES.map((c) => c.name))).toEqual(new Set(treasuryOwn));
  });
  it.each(CASES)("$name($args)", ({ name, args, reason }) => {
    const data = encodeErrorResult({ abi: overflowTreasuryAbi, errorName: name as never, args: args as never });
    const d = decodeRevertData(data)!;
    expect(d.name).toBe(name);
    expect(d.source).toBe("treasury");
    expect(d.reason).toMatch(reason);
    expect(d.args).toEqual(args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))));
  });
});

describe("decodeRevertData: USDC Error(string) and EVM", () => {
  it.each(USDC_REASONS)("%s", (message, reason) => {
    const d = decodeRevertData(errorString(message))!;
    expect(d).toMatchObject({ name: "Error", args: [message], reason, source: "usdc" });
  });
  it("unknown Error(string) keeps the message", () => {
    expect(decodeRevertData(errorString("Something: else"))!.reason).toBe("USDC reverted: Something: else");
  });
  it("Panic", () => {
    const d = decodeRevertData("0x4e487b710000000000000000000000000000000000000000000000000000000000000011")!;
    expect(d).toMatchObject({ name: "Panic", args: ["17"], source: "evm" });
  });
  it("garbage is undefined", () => {
    expect(decodeRevertData("0xdeadbeef00")).toBeUndefined();
    expect(decodeRevertData("0x12")).toBeUndefined();
  });
  it("bypass reason is the USDC invalid-signature mapping", () => {
    expect(BYPASS_REASON).toMatch(/only valid inside treasury.settle/);
  });
});

describe("decodeRevert: viem error shapes", () => {
  const payeeData = encodeErrorResult({ abi: overflowTreasuryAbi, errorName: "PayeeNotAllowed", args: [0n] });
  it("ContractFunctionRevertedError with decoded errorName", () => {
    const inner = new ContractFunctionRevertedError({ abi: overflowTreasuryAbi, data: payeeData, functionName: "settle" });
    const outer = new ContractFunctionExecutionError(inner, { abi: overflowTreasuryAbi, functionName: "settle", args: [] });
    const d = decodeRevert(outer);
    expect(d.name).toBe("PayeeNotAllowed");
    expect(d.args).toEqual(["0"]);
  });
  it("Error(string) through viem", () => {
    const inner = new ContractFunctionRevertedError({ abi: overflowTreasuryAbi, data: errorString("FiatTokenV2: invalid signature"), functionName: "settle" });
    const d = decodeRevert(new ContractFunctionExecutionError(inner, { abi: overflowTreasuryAbi, functionName: "settle", args: [] }));
    expect(d.name).toBe("Error");
    expect(d.reason).toBe(BYPASS_REASON);
  });
  it("raw hex buried in a cause chain", () => {
    const err = new Error("rpc") as Error & { cause?: unknown };
    err.cause = { cause: { data: payeeData } };
    expect(decodeRevert(err).name).toBe("PayeeNotAllowed");
  });
  it("falls back to the short message", () => {
    const d = decodeRevert(new BaseError("nonce too low"));
    expect(d).toMatchObject({ name: "Unknown", source: "unknown" });
    expect(d.reason).toContain("nonce too low");
    expect(decodeRevert("plain string").reason).toBe("plain string");
  });
});
