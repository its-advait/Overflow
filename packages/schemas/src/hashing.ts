import { encodeAbiParameters, keccak256, parseAbiParameters, stringToBytes, type Hex } from "viem";
import { z } from "zod";
import { AddressSchema, AtomicAmountSchema, Bytes32Schema, UintStringSchema } from "./primitives";

// ---------------------------------------------------------------------------
// Fixed-field hashing (docs/SPEC.md "The escrow address is the order").
// Never hash JSON: key order and number formats change the hash.
// The Solidity side (OverflowEscrowFactory / OverflowEscrow) must use the
// exact field order and types written in the parseAbiParameters strings below.
// ---------------------------------------------------------------------------

const MAX_UINT64 = (1n << 64n) - 1n;

const Uint64Schema = UintStringSchema.refine(
  (v) => !/^\d+$/.test(v) || BigInt(v) <= MAX_UINT64,
  "exceeds uint64",
);

/**
 * Delivery terms covered by `termsHash`. Buyer, seller, missionId and
 * resourceId are bound by `orderId`, so they are not repeated here.
 */
export const TermsHashInputSchema = z.object({
  token: AddressSchema,
  amountAtomic: AtomicAmountSchema,
  bondAtomic: AtomicAmountSchema,
  manifestHash: Bytes32Schema,
  rootPlain: Bytes32Schema,
  rootCipher: Bytes32Schema,
  keyCommitment: Bytes32Schema,
  /** Unix seconds. */
  revealDeadline: Uint64Schema,
  /** Seconds. */
  challengeWindow: Uint64Schema,
  sourceKey: AddressSchema,
  /** Unix seconds; minimum record timestamp the source promised. */
  minTimestamp: Uint64Schema,
});
export type TermsHashInput = z.infer<typeof TermsHashInputSchema>;

/**
 * Solidity equivalent:
 *   keccak256(abi.encode(token, amount, bond, manifestHash, rootPlain, rootCipher,
 *             keyCommitment, revealDeadline, challengeWindow, sourceKey, minTimestamp))
 */
export const TERMS_HASH_ABI = parseAbiParameters(
  "address token, uint256 amount, uint256 bond, bytes32 manifestHash, bytes32 rootPlain, bytes32 rootCipher, bytes32 keyCommitment, uint64 revealDeadline, uint64 challengeWindow, address sourceKey, uint64 minTimestamp",
);

export function computeTermsHash(input: TermsHashInput): Hex {
  const t = TermsHashInputSchema.parse(input);
  return keccak256(
    encodeAbiParameters(TERMS_HASH_ABI, [
      t.token,
      BigInt(t.amountAtomic),
      BigInt(t.bondAtomic),
      t.manifestHash,
      t.rootPlain,
      t.rootCipher,
      t.keyCommitment,
      BigInt(t.revealDeadline),
      BigInt(t.challengeWindow),
      t.sourceKey,
      BigInt(t.minTimestamp),
    ]),
  );
}

/** Offchain string ids (uuids) become bytes32 as keccak256 of their UTF-8 bytes. */
export function hashIdToBytes32(id: string): Hex {
  if (typeof id !== "string" || id.length === 0) throw new Error("id must be a non-empty string");
  return keccak256(stringToBytes(id));
}

export const OrderIdInputSchema = z.object({
  missionId: z.string().min(1),
  resourceId: z.string().min(1),
  buyer: AddressSchema,
  seller: AddressSchema,
  amountAtomic: AtomicAmountSchema,
  termsHash: Bytes32Schema,
  salt: Bytes32Schema,
});
export type OrderIdInput = z.infer<typeof OrderIdInputSchema>;

/**
 * Solidity equivalent:
 *   keccak256(abi.encode(missionId, resourceId, buyer, seller, amount, termsHash, salt))
 * where missionId and resourceId are bytes32 = keccak256(bytes(idString)).
 */
export const ORDER_ID_ABI = parseAbiParameters(
  "bytes32 missionId, bytes32 resourceId, address buyer, address seller, uint256 amount, bytes32 termsHash, bytes32 salt",
);

export function computeOrderId(input: OrderIdInput): Hex {
  const o = OrderIdInputSchema.parse(input);
  return keccak256(
    encodeAbiParameters(ORDER_ID_ABI, [
      hashIdToBytes32(o.missionId),
      hashIdToBytes32(o.resourceId),
      o.buyer,
      o.seller,
      BigInt(o.amountAtomic),
      o.termsHash,
      o.salt,
    ]),
  );
}
