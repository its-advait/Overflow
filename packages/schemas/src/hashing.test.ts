import { encodeAbiParameters, keccak256, parseAbiParameters, stringToBytes, toHex } from "viem";
import { describe, expect, it } from "vitest";
import {
  Bytes32Schema,
  ORDER_ID_ABI,
  TERMS_HASH_ABI,
  computeOrderId,
  computeTermsHash,
  hashIdToBytes32,
  type OrderIdInput,
  type TermsHashInput,
} from "./index";

const b32 = (n: number) => toHex(n, { size: 32 });
const addr = (n: number) => toHex(n, { size: 20 });

const terms: TermsHashInput = {
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amountAtomic: "12000000",
  bondAtomic: "2400000",
  manifestHash: b32(1),
  rootPlain: b32(2),
  rootCipher: b32(3),
  keyCommitment: b32(4),
  revealDeadline: "1761350400",
  challengeWindow: "3600",
  sourceKey: addr(9),
  minTimestamp: "1704067200",
};

const order: OrderIdInput = {
  missionId: "mission-ev-market",
  resourceId: "ev-registrations-us-monthly",
  buyer: addr(1),
  seller: addr(2),
  amountAtomic: "12000000",
  termsHash: computeTermsHash(terms),
  salt: b32(42),
};

describe("hashIdToBytes32", () => {
  it("is keccak256 of the UTF-8 bytes", () => {
    expect(hashIdToBytes32("m1")).toBe(keccak256(stringToBytes("m1")));
    expect(Bytes32Schema.safeParse(hashIdToBytes32("anything")).success).toBe(true);
  });
  it("rejects empty ids", () => {
    expect(() => hashIdToBytes32("")).toThrow();
  });
});

describe("computeTermsHash", () => {
  it("is deterministic and a bytes32", () => {
    const h = computeTermsHash(terms);
    expect(computeTermsHash({ ...terms })).toBe(h);
    expect(Bytes32Schema.safeParse(h).success).toBe(true);
  });

  it("matches an independently encoded vector in the documented field order", () => {
    const expected = keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          "address, uint256, uint256, bytes32, bytes32, bytes32, bytes32, uint64, uint64, address, uint64",
        ),
        [
          terms.token,
          12000000n,
          2400000n,
          terms.manifestHash,
          terms.rootPlain,
          terms.rootCipher,
          terms.keyCommitment,
          1761350400n,
          3600n,
          terms.sourceKey,
          1704067200n,
        ],
      ),
    );
    expect(computeTermsHash(terms)).toBe(expected);
    expect(TERMS_HASH_ABI.map((p) => p.type)).toEqual([
      "address",
      "uint256",
      "uint256",
      "bytes32",
      "bytes32",
      "bytes32",
      "bytes32",
      "uint64",
      "uint64",
      "address",
      "uint64",
    ]);
  });

  it("changes when any single field changes", () => {
    const base = computeTermsHash(terms);
    const variants: TermsHashInput[] = [
      { ...terms, token: addr(7) },
      { ...terms, amountAtomic: "12000001" },
      { ...terms, bondAtomic: "0" },
      { ...terms, manifestHash: b32(101) },
      { ...terms, rootPlain: b32(102) },
      { ...terms, rootCipher: b32(103) },
      { ...terms, keyCommitment: b32(104) },
      { ...terms, revealDeadline: "1761350401" },
      { ...terms, challengeWindow: "3601" },
      { ...terms, sourceKey: addr(10) },
      { ...terms, minTimestamp: "1704067201" },
    ];
    expect(variants).toHaveLength(Object.keys(terms).length);
    const seen = new Set<string>([base]);
    for (const v of variants) {
      const h = computeTermsHash(v);
      expect(h).not.toBe(base);
      expect(seen.has(h)).toBe(false);
      seen.add(h);
    }
  });

  it("rejects floats, bad hex and values over uint64", () => {
    expect(() => computeTermsHash({ ...terms, amountAtomic: "1.5" })).toThrow();
    expect(() => computeTermsHash({ ...terms, manifestHash: "0x12" as never })).toThrow();
    expect(() => computeTermsHash({ ...terms, challengeWindow: "18446744073709551616" })).toThrow();
    expect(() => computeTermsHash({ ...terms, challengeWindow: "18446744073709551615" })).not.toThrow();
  });
});

describe("computeOrderId", () => {
  it("is deterministic and a bytes32", () => {
    const id = computeOrderId(order);
    expect(computeOrderId({ ...order })).toBe(id);
    expect(Bytes32Schema.safeParse(id).success).toBe(true);
  });

  it("matches the spec formula with bytes32 ids and the documented order", () => {
    const expected = keccak256(
      encodeAbiParameters(
        parseAbiParameters("bytes32, bytes32, address, address, uint256, bytes32, bytes32"),
        [
          keccak256(stringToBytes(order.missionId)),
          keccak256(stringToBytes(order.resourceId)),
          order.buyer,
          order.seller,
          12000000n,
          order.termsHash,
          order.salt,
        ],
      ),
    );
    expect(computeOrderId(order)).toBe(expected);
    expect(ORDER_ID_ABI.map((p) => p.type)).toEqual([
      "bytes32",
      "bytes32",
      "address",
      "address",
      "uint256",
      "bytes32",
      "bytes32",
    ]);
  });

  it("changes when any single field changes", () => {
    const base = computeOrderId(order);
    const variants: OrderIdInput[] = [
      { ...order, missionId: "mission-ev-market-2" },
      { ...order, resourceId: "ev-registrations-ca-monthly" },
      { ...order, buyer: addr(3) },
      { ...order, seller: addr(4) },
      { ...order, amountAtomic: "12000001" },
      { ...order, termsHash: b32(77) },
      { ...order, salt: b32(43) },
    ];
    expect(variants).toHaveLength(Object.keys(order).length);
    const seen = new Set<string>([base]);
    for (const v of variants) {
      const h = computeOrderId(v);
      expect(h).not.toBe(base);
      expect(seen.has(h)).toBe(false);
      seen.add(h);
    }
  });

  it("swapping buyer and seller changes the id", () => {
    expect(computeOrderId({ ...order, buyer: order.seller, seller: order.buyer })).not.toBe(
      computeOrderId(order),
    );
  });

  it("does not depend on object key order (fixed fields, not JSON)", () => {
    const reordered = {
      salt: order.salt,
      termsHash: order.termsHash,
      amountAtomic: order.amountAtomic,
      seller: order.seller,
      buyer: order.buyer,
      resourceId: order.resourceId,
      missionId: order.missionId,
    };
    expect(computeOrderId(reordered)).toBe(computeOrderId(order));
  });

  it("rejects invalid inputs", () => {
    expect(() => computeOrderId({ ...order, amountAtomic: "12.0" })).toThrow();
    expect(() => computeOrderId({ ...order, missionId: "" })).toThrow();
    expect(() => computeOrderId({ ...order, salt: "0xabc" as never })).toThrow();
  });
});
