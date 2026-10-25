import { concat, keccak256, recoverTypedDataAddress, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { USDC } from "@overflow/schemas";
import {
  DEFAULT_RESERVATION_WINDOW_SECONDS,
  SigningRefusedError,
  TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
  TRANSFER_WITH_AUTHORIZATION_TYPE_STRING,
  USDC_DOMAIN,
  VALID_AFTER_SKEW_SECONDS,
  transferAuthorizationDigest,
  authorizationDigestFromSeparator,
  authorizationFromJson,
  authorizationStructHash,
  authorizationToJson,
  buildAuthorization,
  isAuthorizationLive,
  randomNonce,
  signTransfer,
} from "./index";

const TREASURY = "0x1111111111111111111111111111111111111111" as const;
const TO = "0x2222222222222222222222222222222222222222" as const;
const NOW = 1_800_000_000;

describe("constants", () => {
  it("typehash is keccak256 of the type string and matches USDC's", () => {
    expect(keccak256(toHex(TRANSFER_WITH_AUTHORIZATION_TYPE_STRING))).toBe(TRANSFER_WITH_AUTHORIZATION_TYPEHASH);
    expect(TRANSFER_WITH_AUTHORIZATION_TYPEHASH).toBe("0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267");
  });
  it("default domain is the pinned USDC domain", () => {
    expect(USDC_DOMAIN).toEqual({ name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC.address });
  });
});

describe("buildAuthorization", () => {
  it("validAfter = now - 5 strictly in the past; validBefore = now + ttl", () => {
    const a = buildAuthorization({ treasury: TREASURY, to: TO, value: 1n, ttlSeconds: 120, nowSeconds: NOW });
    expect(a.from).toBe(TREASURY);
    expect(a.validAfter).toBe(BigInt(NOW - VALID_AFTER_SKEW_SECONDS));
    expect(a.validAfter).toBeLessThan(BigInt(NOW));
    expect(a.validBefore).toBe(BigInt(NOW + 120));
    expect(a.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("the strict validAfter rule: USDC accepts the authorization at block.timestamp == now", () => {
    const a = buildAuthorization({ treasury: TREASURY, to: TO, value: 1n, ttlSeconds: 120, nowSeconds: NOW });
    // FiatTokenV2: require(now > validAfter, "authorization is not yet valid")
    expect(isAuthorizationLive(a, BigInt(NOW))).toEqual({ live: true });
    expect(isAuthorizationLive(a, BigInt(NOW - 4))).toEqual({ live: true });
    expect(isAuthorizationLive(a, a.validAfter)).toEqual({ live: false, reason: "not-yet-valid" });
    expect(isAuthorizationLive(a, a.validAfter + 1n)).toEqual({ live: true });
    // An authorization with validAfter == now would be rejected in a block at now.
    const naive = { ...a, validAfter: BigInt(NOW) };
    expect(isAuthorizationLive(naive, BigInt(NOW))).toEqual({ live: false, reason: "not-yet-valid" });
    // require(now < validBefore, "authorization is expired"): also strict.
    expect(isAuthorizationLive(a, a.validBefore - 1n)).toEqual({ live: true });
    expect(isAuthorizationLive(a, a.validBefore)).toEqual({ live: false, reason: "expired" });
  });

  it("caps validBefore at the reservation window (default 600s)", () => {
    const a = buildAuthorization({ treasury: TREASURY, to: TO, value: 1n, ttlSeconds: 3600, nowSeconds: NOW });
    expect(a.validBefore).toBe(BigInt(NOW + DEFAULT_RESERVATION_WINDOW_SECONDS));
    const b = buildAuthorization({
      treasury: TREASURY,
      to: TO,
      value: 1n,
      ttlSeconds: 3600,
      reservationWindowSeconds: 300,
      nowSeconds: NOW,
    });
    expect(b.validBefore).toBe(BigInt(NOW + 300));
    const c = buildAuthorization({ treasury: TREASURY, to: TO, value: 1n, ttlSeconds: 60, reservationWindowSeconds: 300, nowSeconds: NOW });
    expect(c.validBefore).toBe(BigInt(NOW + 60));
  });

  it("nonces are random 32 bytes and never repeat", () => {
    const a = buildAuthorization({ treasury: TREASURY, to: TO, value: 1n, ttlSeconds: 60, nowSeconds: NOW });
    const b = buildAuthorization({ treasury: TREASURY, to: TO, value: 1n, ttlSeconds: 60, nowSeconds: NOW });
    expect(a.nonce).not.toBe(b.nonce);
    const seen = new Set<Hex>();
    for (let i = 0; i < 200; i++) seen.add(randomNonce());
    expect(seen.size).toBe(200);
  });

  it("accepts decimal-string values and rejects zero, floats and bad ttl", () => {
    expect(buildAuthorization({ treasury: TREASURY, to: TO, value: "8400000", ttlSeconds: 60, nowSeconds: NOW }).value).toBe(8400000n);
    expect(() => buildAuthorization({ treasury: TREASURY, to: TO, value: 0n, ttlSeconds: 60 })).toThrow(/positive/);
    expect(() => buildAuthorization({ treasury: TREASURY, to: TO, value: "8.4", ttlSeconds: 60 })).toThrow();
    expect(() => buildAuthorization({ treasury: TREASURY, to: TO, value: 1n, ttlSeconds: 0 })).toThrow();
    expect(() => buildAuthorization({ treasury: TREASURY, to: TO, value: 1n, ttlSeconds: 1.5 })).toThrow();
  });

  it("JSON round trip keeps every integer as a decimal string", () => {
    const a = buildAuthorization({ treasury: TREASURY, to: TO, value: 123n, ttlSeconds: 60, nowSeconds: NOW });
    const j = authorizationToJson(a);
    expect(j).toEqual({
      from: TREASURY,
      to: TO,
      value: "123",
      validAfter: String(NOW - 5),
      validBefore: String(NOW + 60),
      nonce: a.nonce,
    });
    expect(authorizationFromJson(j)).toEqual(a);
  });
});

describe("digest", () => {
  it("hashTypedData == keccak256(0x1901 || pinned DOMAIN_SEPARATOR || structHash)", () => {
    const a = buildAuthorization({ treasury: TREASURY, to: TO, value: 20000n, ttlSeconds: 120, nowSeconds: NOW, nonce: `0x${"ab".repeat(32)}` });
    const manual = keccak256(concat(["0x1901", USDC.domainSeparator, authorizationStructHash(a)]));
    expect(transferAuthorizationDigest(USDC_DOMAIN, a)).toBe(manual);
    expect(authorizationDigestFromSeparator(USDC.domainSeparator, a)).toBe(manual);
  });
  it("changes when from changes (the treasury is bound into the digest)", () => {
    const a = buildAuthorization({ treasury: TREASURY, to: TO, value: 1n, ttlSeconds: 60, nowSeconds: NOW, nonce: `0x${"01".repeat(32)}` });
    const b = { ...a, from: TO };
    expect(transferAuthorizationDigest(USDC_DOMAIN, a)).not.toBe(transferAuthorizationDigest(USDC_DOMAIN, b));
  });
});

describe("signTransfer", () => {
  it("signs with the node key, from = treasury, and the signature recovers to the node key", async () => {
    const nodeAccount = privateKeyToAccount(generatePrivateKey());
    const signed = await signTransfer({ nodeAccount, treasury: TREASURY, to: TO, value: 8400000n, ttlSeconds: 60, nowSeconds: NOW });
    expect(signed.authorization.from).toBe(TREASURY);
    expect(signed.authorizationJson.from).toBe(TREASURY);
    expect(signed.typedData.message.from).toBe(TREASURY);
    expect(signed.signer).toBe(nodeAccount.address);
    expect(signed.signature).toHaveLength(2 + 65 * 2);
    expect(signed.digest).toBe(transferAuthorizationDigest(USDC_DOMAIN, signed.authorization));
    expect(await recoverTypedDataAddress({ ...signed.typedData, signature: signed.signature })).toBe(nodeAccount.address);
    expect(signed.authorization.validAfter).toBe(BigInt(NOW - 5));
    expect(signed.authorization.validBefore).toBe(BigInt(NOW + 60));
  });

  it("refuses when the node key is the treasury (from must never be the signer)", async () => {
    const nodeAccount = privateKeyToAccount(generatePrivateKey());
    await expect(
      signTransfer({ nodeAccount, treasury: nodeAccount.address, to: TO, value: 1n, ttlSeconds: 60 }),
    ).rejects.toBeInstanceOf(SigningRefusedError);
  });

  it("refuses a non-USDC domain", async () => {
    const nodeAccount = privateKeyToAccount(generatePrivateKey());
    await expect(
      signTransfer({
        nodeAccount,
        treasury: TREASURY,
        to: TO,
        value: 1n,
        ttlSeconds: 60,
        domain: { ...USDC_DOMAIN, chainId: 8453 },
      }),
    ).rejects.toBeInstanceOf(SigningRefusedError);
    await expect(
      signTransfer({ nodeAccount, treasury: TREASURY, to: TO, value: 1n, ttlSeconds: 60, domain: { ...USDC_DOMAIN, version: "1" } }),
    ).rejects.toBeInstanceOf(SigningRefusedError);
  });

  it("discards a signature that does not recover to the node key", async () => {
    const real = privateKeyToAccount(generatePrivateKey());
    const impostor = privateKeyToAccount(generatePrivateKey());
    const nodeAccount = { address: real.address, signTypedData: impostor.signTypedData.bind(impostor) };
    await expect(signTransfer({ nodeAccount, treasury: TREASURY, to: TO, value: 1n, ttlSeconds: 60 })).rejects.toThrow(/recovers to/);
  });
});
