import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

const base = { BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org" };
const KEY = `0x${"a11ce".padStart(64, "0")}`;
const ADDR = "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7";

describe("readConfig: relayer signer sources", () => {
  it("accepts a 64-hex dev key", () => {
    expect(readConfig({ ...base, RELAYER_PRIVATE_KEY: KEY }).relayer).toEqual({ keyOrAddress: KEY, account: undefined, passwordFile: undefined });
  });
  it("accepts an address slot plus keystore name and password file", () => {
    const c = readConfig({ ...base, RELAYER_PRIVATE_KEY: ADDR, RELAYER_ACCOUNT: "overflow-relayer", RELAYER_PASSWORD_FILE: "/run/secrets/relayer" });
    expect(c.relayer).toEqual({ keyOrAddress: ADDR, account: "overflow-relayer", passwordFile: "/run/secrets/relayer" });
  });
  it("refuses an address without a keystore, and garbage in the slot", () => {
    expect(() => readConfig({ ...base, RELAYER_PRIVATE_KEY: ADDR })).toThrow(/RELAYER_ACCOUNT \+ RELAYER_PASSWORD_FILE/);
    expect(() => readConfig({ ...base, RELAYER_PRIVATE_KEY: ADDR, RELAYER_ACCOUNT: "overflow-relayer" })).toThrow(/RELAYER_PASSWORD_FILE/);
    expect(() => readConfig(base)).toThrow(/relayer signer/);
    expect(() => readConfig({ ...base, RELAYER_PRIVATE_KEY: "0x12" })).toThrow(/64-hex key, or the relayer's address/);
  });
  it("demo mode needs a token", () => {
    expect(() => readConfig({ ...base, RELAYER_PRIVATE_KEY: KEY, DEMO_MODE: "true" })).toThrow(/DEMO_TOKEN/);
    expect(readConfig({ ...base, RELAYER_PRIVATE_KEY: KEY, DEMO_MODE: "true", DEMO_TOKEN: "demo-token-at-least-16" }).demoMode).toBe(true);
  });
});
