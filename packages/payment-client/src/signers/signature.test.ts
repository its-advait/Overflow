import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { inspectSignature, normalizeEcdsaSignature, SignatureFormatError } from "./signature";

// SIMULATED key: derived from a label, never funded.
const KEY = keccak256(toHex("overflow.simulated.signature-test"));
const ACCOUNT = privateKeyToAccount(KEY);
const HASH = keccak256(toHex("hello"));

describe("normalizeEcdsaSignature", () => {
  it("passes a canonical 65-byte signature through unchanged", async () => {
    const sig = await sign({ hash: HASH, privateKey: KEY, to: "hex" });
    expect(inspectSignature(sig)).toMatchObject({ bytes: 65, lowS: true, canonical: true });
    expect([27, 28]).toContain(inspectSignature(sig).vByte);
    expect(normalizeEcdsaSignature(sig)).toBe(sig);
  });

  it("lifts v = 0/1 to 27/28 and keeps r, s", async () => {
    const sig = await sign({ hash: HASH, privateKey: KEY, to: "hex" });
    const v = Number.parseInt(sig.slice(-2), 16);
    const yParity = (v - 27).toString(16).padStart(2, "0");
    const raw = `${sig.slice(0, -2)}${yParity}`;
    expect(inspectSignature(raw)).toMatchObject({ bytes: 65, vByte: v - 27, canonical: false });
    expect(normalizeEcdsaSignature(raw)).toBe(sig);
  });

  it("accepts input without the 0x prefix", async () => {
    const sig = await sign({ hash: HASH, privateKey: KEY, to: "hex" });
    expect(normalizeEcdsaSignature(sig.slice(2))).toBe(sig);
  });

  it("rejects a high s", async () => {
    const sig = await sign({ hash: HASH, privateKey: KEY, to: "hex" });
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const highS = (n - s).toString(16).padStart(64, "0");
    const raw = `${sig.slice(0, 66)}${highS}${sig.slice(130)}`;
    expect(inspectSignature(raw).lowS).toBe(false);
    expect(() => normalizeEcdsaSignature(raw)).toThrow(SignatureFormatError);
    expect(() => normalizeEcdsaSignature(raw)).toThrow(/high s/);
  });

  it("rejects wrong lengths and non-hex", () => {
    expect(() => normalizeEcdsaSignature(`0x${"ab".repeat(64)}`)).toThrow(/got 64 bytes/);
    expect(() => normalizeEcdsaSignature(`0x${"ab".repeat(66)}`)).toThrow(/got 66 bytes/);
    expect(() => normalizeEcdsaSignature("0xzz")).toThrow(/non-hex/);
    expect(inspectSignature("0x").bytes).toBe(0);
  });

  it("rejects a v byte outside {0, 1, 27, 28}", async () => {
    const sig = await sign({ hash: HASH, privateKey: KEY, to: "hex" });
    expect(() => normalizeEcdsaSignature(`${sig.slice(0, -2)}05`)).toThrow(/v byte is 5/);
  });

  it("never touches the signer: the account is only here to make real signatures", () => {
    expect(ACCOUNT.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
