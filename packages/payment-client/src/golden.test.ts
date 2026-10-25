import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { concat, keccak256, recoverAddress, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { USDC } from "@overflow/schemas";
import {
  GOLDEN_AUTHORIZATION,
  GOLDEN_FIXTURE_RELATIVE_PATH,
  GOLDEN_TEST_ONLY_PRIVATE_KEY,
  GOLDEN_VECTOR_RELATIVE_PATH,
  USDC_DOMAIN,
  transferAuthorizationDigest,
  authorizationFromJson,
  buildTransferTypedData,
  generateGoldenVector,
  serializeGoldenVector,
  type GoldenVector,
} from "./index";

const packageRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageRoot, "../..");
const vectorPath = resolve(packageRoot, GOLDEN_VECTOR_RELATIVE_PATH);
const fixturePath = resolve(repoRoot, GOLDEN_FIXTURE_RELATIVE_PATH);

// Pinned in contracts/test/PaymentClientGolden.t.sol as EXPECTED_DIGEST. Any drift on either side fails.
const EXPECTED_DIGEST = "0xb2d39a5bf926c7a6e8c9447445a9b38006b415db638e540792757a03b40e2dc8";

describe("golden vector (shared with contracts/test/PaymentClientGolden.t.sol)", () => {
  const vector = JSON.parse(readFileSync(vectorPath, "utf8")) as GoldenVector;

  it("test/golden.json is byte-identical to a fresh generation and to the contracts fixture copy", async () => {
    const fresh = serializeGoldenVector(await generateGoldenVector());
    expect(readFileSync(vectorPath, "utf8")).toBe(fresh);
    expect(readFileSync(fixturePath, "utf8")).toBe(fresh);
  });

  it("digest equals hashTypedData, the manual 0x1901 construction, and the pinned constant", () => {
    const auth = authorizationFromJson(vector.authorization);
    expect(auth).toEqual(GOLDEN_AUTHORIZATION);
    expect(auth.from).toBe("0x1111111111111111111111111111111111111111"); // the treasury, not the signer
    expect(vector.domainSeparator).toBe(USDC.domainSeparator);
    expect(vector.usdc).toBe(USDC.address);
    const digest = transferAuthorizationDigest(USDC_DOMAIN, auth);
    expect(digest).toBe(vector.digest);
    expect(keccak256(concat(["0x1901", vector.domainSeparator, vector.structHash]))).toBe(vector.digest);
    expect(vector.digest).toBe(EXPECTED_DIGEST);
  });

  it("signature is from the public TEST ONLY key and recovers to the signer, who is not `from`", async () => {
    expect(vector.testOnlyPrivateKey).toBe(GOLDEN_TEST_ONLY_PRIVATE_KEY);
    const account = privateKeyToAccount(GOLDEN_TEST_ONLY_PRIVATE_KEY);
    expect(vector.signer).toBe(account.address);
    expect(await recoverAddress({ hash: vector.digest, signature: vector.signature })).toBe(vector.signer);
    const td = buildTransferTypedData(USDC_DOMAIN, authorizationFromJson(vector.authorization));
    expect(await recoverTypedDataAddress({ ...td, signature: vector.signature })).toBe(vector.signer);
    expect(vector.signer.toLowerCase()).not.toBe(vector.authorization.from.toLowerCase());
  });
});
