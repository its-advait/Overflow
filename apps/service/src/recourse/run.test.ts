import { buildAuthorization } from "@overflow/payment-client";
import { describe, expect, it } from "vitest";
import { authorizationWindow, BOOT_ORDERS } from "./run.js";

const TREASURY = "0x1111111111111111111111111111111111111111";
const ESCROW = "0x3333333333333333333333333333333333333333";

/** Both clocks that judge an authorization: the facilitator's wall clock and Anvil's block clock. */
function validUnder(window: ReturnType<typeof authorizationWindow>, clocks: bigint[]): boolean {
  const a = buildAuthorization({ treasury: TREASURY, to: ESCROW, value: 1n, ttlSeconds: window.ttlSeconds, reservationWindowSeconds: window.ttlSeconds, nowSeconds: window.nowSeconds });
  return clocks.every((t) => t > a.validAfter && t < a.validBefore);
}

describe("authorizationWindow", () => {
  const wall = 1_800_000_000n;
  it("after an evm_increaseTime the chain clock runs ahead: the window opens at the wall clock and closes after the chain clock", () => {
    const w = authorizationWindow(wall + 1800n, wall);
    expect(w).toEqual({ nowSeconds: Number(wall), ttlSeconds: 1800 + 600 });
    expect(validUnder(w, [wall, wall + 1800n])).toBe(true);
  });
  it("a stale fork block puts the chain clock behind: the window opens at the chain clock", () => {
    const w = authorizationWindow(wall - 120n, wall);
    expect(w).toEqual({ nowSeconds: Number(wall - 120n), ttlSeconds: 120 + 600 });
    expect(validUnder(w, [wall - 120n, wall])).toBe(true);
  });
  it("equal clocks give the plain 600 s window", () => {
    expect(authorizationWindow(wall, wall)).toEqual({ nowSeconds: Number(wall), ttlSeconds: 600 });
  });
});

describe("BOOT_ORDERS", () => {
  it("is the P5.2 cast: honest, ghost, swap on three seeded listings", () => {
    expect(BOOT_ORDERS.map((o) => o.behaviour)).toEqual(["honest", "ghost", "swap"]);
    expect(new Set(BOOT_ORDERS.map((o) => o.listingId)).size).toBe(3);
  });
});
