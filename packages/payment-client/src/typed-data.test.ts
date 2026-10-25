import { domainSeparator, keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { USDC } from "@overflow/schemas";
import {
  AuthorizationSchema,
  authorizationDigest,
  createChildDigest,
  delegationDomain,
  pauseChildDigest,
  payeesHash,
  randomNonce,
  recoverAuthorizationSigner,
  SignatureSchema,
  signAuthorization,
  signCreateChild,
  TokenDomainMismatch,
  TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
  usdcDomainSeparator,
  verifyTokenDomain,
  type Authorization,
  type TokenReader,
} from "./typed-data";

// Golden vectors shared with contracts/test/unit/TypedDataVectors.t.sol.
const TREASURY = "0xd3A74fA991CA0B5627d30EF27dC699C134848291" as const;
const AUTH: Authorization = {
  from: TREASURY,
  to: "0x1111111111111111111111111111111111111111",
  value: "50000",
  validAfter: "1791699995",
  validBefore: "1791700120",
  nonce: `0x${"ab".repeat(32)}`,
};
const CHILD = {
  parentId: "1",
  key: "0x2222222222222222222222222222222222222222" as const,
  cap: "1000000",
  maxPerCall: "100000",
  expiry: "1791786400",
  restricted: true,
  payees: ["0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"] as `0x${string}`[],
  nonce: "7",
  deadline: "1791700300",
};

describe("typed data golden vectors (match TypedDataVectors.t.sol)", () => {
  it("USDC domain separator and TransferWithAuthorization digest", () => {
    expect(usdcDomainSeparator()).toBe(USDC.domainSeparator);
    expect(TRANSFER_WITH_AUTHORIZATION_TYPEHASH).toBe(
      keccak256(
        stringToBytes(
          "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
        ),
      ),
    );
    expect(authorizationDigest(AUTH)).toBe("0xa3f48a6a5246ed982e588ec8c6c82ad870fd6bf59527923cfe81d9e0072ab185");
  });
  it("delegation domain, payeesHash, CreateChild and PauseChild digests", () => {
    expect(domainSeparator({ domain: delegationDomain(TREASURY) })).toBe(
      "0x70a93dac43b2061c8fc826a973d59b1a987c11fb52c32c9cb24a3d9629e5f364",
    );
    expect(payeesHash(CHILD.payees)).toBe("0xa80d18648e85a4cbf5f5bdbd1d95c6b800466af832d6e4435a6b6debe458122d");
    expect(createChildDigest(TREASURY, CHILD)).toBe("0x85e21bc13253f2d4774b66478096c12606d1375c8c82532ad6f7629942872867");
    expect(pauseChildDigest(TREASURY, { target: "3", nonce: "9", deadline: "1791700300" })).toBe(
      "0x199b55db57c8e334a5d2ce35f8197bea0c4528e9b3297d3ccf583bef6aa6d0fe",
    );
  });
});

describe("signing", () => {
  const node = privateKeyToAccount(`0x${"a11ce".padStart(64, "0")}`);
  it("signs an authorization that recovers to the node key", async () => {
    const sig = await signAuthorization(node, AUTH);
    expect(SignatureSchema.safeParse(sig).success).toBe(true);
    expect(await recoverAuthorizationSigner(AUTH, sig)).toBe(node.address);
    expect(await recoverAuthorizationSigner({ ...AUTH, value: "50001" }, sig)).not.toBe(node.address);
  });
  it("signs a CreateChild for the treasury domain", async () => {
    const sig = await signCreateChild(node, TREASURY, CHILD);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });
  it("nonces are 32 random bytes", () => {
    const a = randomNonce();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(randomNonce()).not.toBe(a);
  });
  it("authorization schema rejects floats, bad addresses and short nonces", () => {
    expect(AuthorizationSchema.safeParse(AUTH).success).toBe(true);
    expect(AuthorizationSchema.safeParse({ ...AUTH, value: "0.05" }).success).toBe(false);
    expect(AuthorizationSchema.safeParse({ ...AUTH, to: "0x1234" }).success).toBe(false);
    expect(AuthorizationSchema.safeParse({ ...AUTH, nonce: "0xabab" }).success).toBe(false);
  });
});

describe("verifyTokenDomain", () => {
  const good: Record<string, unknown> = { name: "USDC", version: "2", decimals: 6, DOMAIN_SEPARATOR: USDC.domainSeparator };
  const reader = (overrides: Record<string, unknown> = {}): TokenReader => ({
    readContract: async ({ functionName }) => ({ ...good, ...overrides })[functionName],
  });
  it("passes for the live USDC values", async () => {
    const d = await verifyTokenDomain(reader());
    expect(d.domainSeparator).toBe(USDC.domainSeparator);
    expect(d.decimals).toBe(6);
  });
  it.each([
    ["name", { name: "Agora Dollar" }],
    ["version", { version: "1" }],
    ["decimals", { decimals: 18 }],
    ["separator", { DOMAIN_SEPARATOR: `0x${"00".repeat(32)}` }],
  ])("fails loudly on a %s mismatch", async (_label, o) => {
    await expect(verifyTokenDomain(reader(o))).rejects.toBeInstanceOf(TokenDomainMismatch);
  });
  it("fails on a different token address even with matching fields", async () => {
    await expect(verifyTokenDomain(reader(), "0x1111111111111111111111111111111111111111")).rejects.toThrow(/address/);
  });
});
