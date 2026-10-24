import { describe, expect, it } from "vitest";
import { AddressSchema, AtomicAmountSchema, CHAIN_ID, USDC_DECIMALS } from "./index.js";

describe("@overflow/schemas scaffold", () => {
  it("pins chain constants", () => {
    expect(CHAIN_ID).toBe(84532);
    expect(USDC_DECIMALS).toBe(6);
  });

  it("accepts the Base Sepolia USDC address", () => {
    expect(
      AddressSchema.safeParse("0x036CbD53842c5426634e7929541eC2318f3dCF7e").success,
    ).toBe(true);
    expect(AddressSchema.safeParse("0x1234").success).toBe(false);
  });

  it("rejects floats as amounts", () => {
    expect(AtomicAmountSchema.safeParse("1000000").success).toBe(true);
    expect(AtomicAmountSchema.safeParse("1.5").success).toBe(false);
  });
});
