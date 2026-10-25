import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { decryptKeystore, KeystoreError, readPasswordFile, resolveKeystorePath, resolveSigner } from "./keystore";

// Throwaway fixture: `cast wallet import throwaway-a11ce --private-key 0x...a11ce --unsafe-password <pw>`.
// The key is the public test vector used across this repo, never a real wallet.
const FIXTURES = resolve(fileURLToPath(import.meta.url), "..", "..", "test-fixtures");
const FIXTURE = join(FIXTURES, "throwaway-a11ce");
const PASSWORD = "overflow-throwaway-fixture-password";
const KEY = `0x${"a11ce".padStart(64, "0")}` as const;
const ADDRESS = privateKeyToAccount(KEY).address;
const json = () => JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;

function passwordFile(text = PASSWORD, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "overflow-ks-"));
  const p = join(dir, "password");
  writeFileSync(p, text);
  chmodSync(p, mode);
  return p;
}

describe("decryptKeystore (cast-generated scrypt/aes-128-ctr)", () => {
  it("recovers the throwaway key", () => {
    expect(decryptKeystore(json(), PASSWORD)).toBe(KEY);
  });
  it("wrong password fails the MAC check", () => {
    expect(() => decryptKeystore(json(), "nope")).toThrow(/MAC mismatch/);
  });
  it("rejects unsupported formats loudly", () => {
    const j = json();
    expect(() => decryptKeystore({ ...j, version: 2 }, PASSWORD)).toThrow(KeystoreError);
    const c = j["crypto"] as Record<string, unknown>;
    expect(() => decryptKeystore({ ...j, crypto: { ...c, kdf: "pbkdf2" } }, PASSWORD)).toThrow(/unsupported keystore/);
    expect(() => decryptKeystore("not json", PASSWORD)).toThrow(KeystoreError);
  });
});

describe("password file and keystore path", () => {
  it("reads a 0600 file and drops the trailing newline", () => {
    expect(readPasswordFile(passwordFile(`${PASSWORD}\n`))).toBe(PASSWORD);
  });
  it("refuses group/other-readable, empty and missing files", () => {
    expect(() => readPasswordFile(passwordFile(PASSWORD, 0o644))).toThrow(/chmod 600/);
    expect(() => readPasswordFile(passwordFile("", 0o600))).toThrow(/empty/);
    expect(() => readPasswordFile("/nonexistent/overflow-pw")).toThrow(/missing/);
  });
  it("resolves names under the keystores dir and keeps absolute paths", () => {
    expect(resolveKeystorePath("overflow-relayer", "/ks")).toBe("/ks/overflow-relayer");
    expect(resolveKeystorePath("/abs/file", "/ks")).toBe("/abs/file");
    expect(() => resolveKeystorePath("../escape", "/ks")).toThrow(KeystoreError);
  });
});

describe("resolveSigner", () => {
  it("prefers a 64-hex key in the env slot", () => {
    const r = resolveSigner({ keyOrAddress: KEY, label: "RELAYER" });
    expect(r.account.address).toBe(ADDRESS);
    expect(r.source).toBe("RELAYER_PRIVATE_KEY (env)");
  });
  it("loads the keystore when the slot holds the address, and checks it matches", () => {
    const r = resolveSigner({ keyOrAddress: ADDRESS.toLowerCase(), account: "throwaway-a11ce", passwordFile: passwordFile(), keystoresDir: FIXTURES, label: "RELAYER" });
    expect(r.account.address).toBe(ADDRESS);
    expect(r.source).toBe("keystore throwaway-a11ce");
    expect(() =>
      resolveSigner({ keyOrAddress: "0x1111111111111111111111111111111111111111", account: "throwaway-a11ce", passwordFile: passwordFile(), keystoresDir: FIXTURES, label: "RELAYER" }),
    ).toThrow(/holds 0xe05f.*env slot says 0x1111/);
  });
  it("works with an empty slot and an absolute keystore path", () => {
    const r = resolveSigner({ account: FIXTURE, passwordFile: passwordFile(), label: "AGENT_ROOT" });
    expect(r.account.address).toBe(ADDRESS);
  });
  it("explains what is missing, and never mentions the key", () => {
    expect(() => resolveSigner({ keyOrAddress: ADDRESS, label: "RELAYER" })).toThrow(/RELAYER_ACCOUNT.*RELAYER_PASSWORD_FILE/);
    expect(() => resolveSigner({ keyOrAddress: "0x12", label: "RELAYER" })).toThrow(/64-hex key or a 0x address/);
    expect(() => resolveSigner({ account: "missing-keystore", passwordFile: passwordFile(), keystoresDir: FIXTURES, label: "RELAYER" })).toThrow(/missing or not JSON/);
    try {
      resolveSigner({ account: "throwaway-a11ce", passwordFile: passwordFile("wrong"), keystoresDir: FIXTURES, label: "RELAYER" });
    } catch (e) {
      expect(String(e)).not.toContain("a11ce");
      expect(String(e)).toMatch(/MAC mismatch/);
    }
  });
});
