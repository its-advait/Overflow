import {
  concat,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from "viem";
import { z } from "zod";
import { AddressSchema, Bytes32Schema, CHAIN_ID, UintStringSchema, USDC } from "@overflow/schemas";
import { SigningRefusedError } from "./errors";
import { USDC_DOMAIN, type TokenDomain } from "./token-domain";
import type { Eip3009AuthorizationJson } from "./x402";

// ---------------------------------------------------------------------------
// EIP-3009 TransferWithAuthorization, signed by an agent node key with from = the treasury.
// The treasury's settle()/reserve() rebuild exactly this digest (SPEC "settle() check order" 1)
// and USDC verifies it through ERC-1271. Ported from reference/leash/packages/leash-client.
// ---------------------------------------------------------------------------

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const TRANSFER_WITH_AUTHORIZATION_TYPE_STRING =
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

/** keccak256 of the type string; USDC's TRANSFER_WITH_AUTHORIZATION_TYPEHASH. */
export const TRANSFER_WITH_AUTHORIZATION_TYPEHASH: Hex =
  "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267";

/** USDC requires block.timestamp > validAfter strictly, so back-date by this many seconds. */
export const VALID_AFTER_SKEW_SECONDS = 5;
/** Treasury reservationWindow default (SPEC "reserve() and release()"): 10 minutes. */
export const DEFAULT_RESERVATION_WINDOW_SECONDS = 600;

export interface TransferAuthorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/** Random 32-byte nonce. Never a counter: every node shares the treasury's nonce namespace. */
export function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

const PositiveIntSchema = z.number().int().positive();
const UintSchema = z.union([z.bigint().nonnegative(), UintStringSchema.transform((v) => BigInt(v))]);

export const BuildAuthorizationInputSchema = z.object({
  treasury: AddressSchema,
  to: AddressSchema,
  value: UintSchema.refine((v) => v > 0n, "value must be positive"),
  ttlSeconds: PositiveIntSchema,
  reservationWindowSeconds: PositiveIntSchema.default(DEFAULT_RESERVATION_WINDOW_SECONDS),
  /** Unix seconds; defaults to the wall clock. Tests pin it. */
  nowSeconds: z.number().int().nonnegative().optional(),
  nonce: Bytes32Schema.optional(),
});
export type BuildAuthorizationInput = z.input<typeof BuildAuthorizationInputSchema>;

/**
 * validAfter = now - 5, validBefore = now + min(ttl, reservationWindow), random nonce,
 * from = the treasury (never the signing key).
 */
export function buildAuthorization(input: BuildAuthorizationInput): TransferAuthorization {
  const p = BuildAuthorizationInputSchema.parse(input);
  const now = BigInt(p.nowSeconds ?? Math.floor(Date.now() / 1000));
  const ttl = BigInt(Math.min(p.ttlSeconds, p.reservationWindowSeconds));
  const validAfter = now >= BigInt(VALID_AFTER_SKEW_SECONDS) ? now - BigInt(VALID_AFTER_SKEW_SECONDS) : 0n;
  return {
    from: getAddress(p.treasury),
    to: getAddress(p.to),
    value: p.value,
    validAfter,
    validBefore: now + ttl,
    nonce: p.nonce ?? randomNonce(),
  };
}

export function authorizationToJson(a: TransferAuthorization): Eip3009AuthorizationJson {
  return {
    from: a.from,
    to: a.to,
    value: a.value.toString(),
    validAfter: a.validAfter.toString(),
    validBefore: a.validBefore.toString(),
    nonce: a.nonce,
  };
}

export function authorizationFromJson(a: Eip3009AuthorizationJson): TransferAuthorization {
  return {
    from: getAddress(a.from),
    to: getAddress(a.to),
    value: BigInt(a.value),
    validAfter: BigInt(a.validAfter),
    validBefore: BigInt(a.validBefore),
    nonce: a.nonce,
  };
}

export type TransferTypedData = TypedDataDefinition<
  typeof TRANSFER_WITH_AUTHORIZATION_TYPES,
  "TransferWithAuthorization"
>;

/** The viem typed-data object shared by signing, recovery and tests. */
export function buildTransferTypedData(domain: TokenDomain, authorization: TransferAuthorization): TransferTypedData {
  return {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  };
}

/** structHash = keccak256(abi.encode(TYPEHASH, from, to, value, validAfter, validBefore, nonce)). */
export function authorizationStructHash(a: TransferAuthorization): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [TRANSFER_WITH_AUTHORIZATION_TYPEHASH, a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce],
    ),
  );
}

/** The digest USDC and the treasury compute: keccak256("\x19\x01" || DOMAIN_SEPARATOR || structHash). */
export function authorizationDigest(domain: TokenDomain, authorization: TransferAuthorization): Hex {
  return hashTypedData(buildTransferTypedData(domain, authorization));
}

/** Same digest built by hand from a known separator; used to cross-check hashTypedData. */
export function authorizationDigestFromSeparator(separator: Hex, authorization: TransferAuthorization): Hex {
  return keccak256(concat(["0x1901", separator, authorizationStructHash(authorization)]));
}

export type AuthorizationLiveness =
  | { live: true }
  | { live: false; reason: "not-yet-valid" | "expired" };

/**
 * Mirror of FiatTokenV2's checks: `block.timestamp > validAfter` ("authorization is not yet
 * valid") and `block.timestamp < validBefore` ("authorization is expired"). Both strict.
 */
export function isAuthorizationLive(a: TransferAuthorization, blockTimestamp: bigint): AuthorizationLiveness {
  if (!(blockTimestamp > a.validAfter)) return { live: false, reason: "not-yet-valid" };
  if (!(blockTimestamp < a.validBefore)) return { live: false, reason: "expired" };
  return { live: true };
}

/** Anything that can sign EIP-712 for a known address: viem LocalAccount, a CDP server wallet, ... */
export interface NodeSigner {
  address: Address;
  signTypedData(typedData: TransferTypedData): Promise<Hex>;
}

export interface SignTransferInput {
  nodeAccount: NodeSigner;
  treasury: Address;
  to: Address;
  value: bigint | string;
  ttlSeconds: number;
  reservationWindowSeconds?: number;
  nowSeconds?: number;
  nonce?: Hex;
  /** Defaults to the pinned USDC domain; pass the result of verifyTokenDomain() when available. */
  domain?: TokenDomain;
}

export interface SignedTransferAuthorization {
  authorization: TransferAuthorization;
  authorizationJson: Eip3009AuthorizationJson;
  typedData: TransferTypedData;
  domain: TokenDomain;
  digest: Hex;
  signature: Hex;
  signer: Address;
}

/**
 * Sign a TransferWithAuthorization with an agent node key, from = the treasury.
 * Refuses to sign when the node key is the treasury itself or the domain is not USDC on
 * Base Sepolia. Verifies the signature recovers to the node key before returning.
 */
export async function signTransfer(input: SignTransferInput): Promise<SignedTransferAuthorization> {
  const domain = input.domain ?? USDC_DOMAIN;
  if (
    domain.name !== USDC.name ||
    domain.version !== USDC.version ||
    domain.chainId !== CHAIN_ID ||
    domain.verifyingContract.toLowerCase() !== USDC.address.toLowerCase()
  ) {
    throw new SigningRefusedError(
      `refusing to sign under domain ${JSON.stringify(domain)}; only USDC v2 on chain ${CHAIN_ID} is allowed`,
    );
  }
  const treasury = getAddress(AddressSchema.parse(input.treasury));
  const signerAddress = getAddress(AddressSchema.parse(input.nodeAccount.address));
  if (treasury === signerAddress) {
    throw new SigningRefusedError("refusing to sign: the node key must not be the treasury (from)");
  }

  const authorization = buildAuthorization({
    treasury,
    to: input.to,
    value: typeof input.value === "bigint" ? input.value : UintStringSchema.parse(input.value),
    ttlSeconds: input.ttlSeconds,
    ...(input.reservationWindowSeconds !== undefined ? { reservationWindowSeconds: input.reservationWindowSeconds } : {}),
    ...(input.nowSeconds !== undefined ? { nowSeconds: input.nowSeconds } : {}),
    ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
  });
  if (authorization.from !== treasury) {
    // Unreachable by construction; kept as the rule's last line of defense.
    throw new SigningRefusedError("refusing to sign: from != treasury");
  }

  const typedData = buildTransferTypedData(domain, authorization);
  const digest = hashTypedData(typedData);
  const signature = await input.nodeAccount.signTypedData(typedData);
  const recovered = await recoverTypedDataAddress({ ...typedData, signature });
  if (getAddress(recovered) !== signerAddress) {
    throw new SigningRefusedError(
      `signature recovers to ${recovered}, not the node key ${signerAddress}; discarding it`,
    );
  }

  return {
    authorization,
    authorizationJson: authorizationToJson(authorization),
    typedData,
    domain,
    digest,
    signature,
    signer: signerAddress,
  };
}
