import { encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { treasuryAbi } from "./abi.js";
import { decodeTreasuryRevert } from "./decode.js";

describe("decodeTreasuryRevert", () => {
  it("decodes a treasury custom error from raw revert data", () => {
    const data = encodeErrorResult({ abi: treasuryAbi, errorName: "OverBudget", args: [3n] });
    expect(decodeTreasuryRevert(data)).toEqual({
      name: "OverBudget",
      args: ["3"],
      decoded: "OverBudget(3)",
      reason: "This agent or an ancestor would pass its cap",
    });
  });
  it("walks a viem-style cause chain", () => {
    const data = encodeErrorResult({ abi: treasuryAbi, errorName: "PayeeNotAllowed", args: [0n] });
    const err = { message: "execution reverted", cause: { cause: { data } } };
    expect(decodeTreasuryRevert(err).decoded).toBe("PayeeNotAllowed(0)");
  });
  it("uses viem's own decoding when present", () => {
    const err = { cause: { data: { errorName: "Paused", args: [1n] } } };
    expect(decodeTreasuryRevert(err)).toMatchObject({ decoded: "Paused(1)", reason: "This agent (or an ancestor) is paused" });
  });
  it("decodes USDC Error(string) reverts", () => {
    const data = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "m" }] }],
      errorName: "Error",
      args: ["FiatTokenV2: invalid signature"],
    });
    expect(decodeTreasuryRevert({ data })).toMatchObject({ name: "Error", reason: "FiatTokenV2: invalid signature" });
  });
  it("falls back to the short message", () => {
    expect(decodeTreasuryRevert(new Error("HTTP request failed.\nURL: x"))).toEqual({
      name: "Unknown",
      args: [],
      decoded: 'Unknown("HTTP request failed.")',
      reason: "HTTP request failed.",
    });
  });
});
