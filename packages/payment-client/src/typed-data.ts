import {
  domainSeparator,
  encodePacked,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import { z } from "zod";
import {
  AddressSchema,
  Bytes32Schema,
  CHAIN_ID,
  OVERFLOW_DELEGATION_DOMAIN,
  USDC,
  USDC_EIP712_DOMAIN,
  UintStringSchema,
} from "@overflow/schemas";

/**
 * EIP-712 typed data shared by the facilitator, the demo scripts and (later) the agents.
 * Mirrors OverflowTreasury: _twaDigest (USDC's TransferWithAuthorization with from = treasury) and the
 * delegation domain {"Overflow","1",chainId,treasury}. Golden vectors: contracts/test/unit/TypedDataVectors.t.sol
 * and src/typed-data.test.ts. Money is always a decimal string of atomic units.
 */

// ---------------------------------------------------------------- EIP-3009 TransferWithAuthorization

/**
 * Anything that can sign EIP-712 (a viem local account, a wallet-client account, a hardware signer). Structural so
 * callers on a different viem copy still type-check.
 */
export interface TypedDataSigner {
  readonly address: Address;
  signTypedData(parameters: {
    domain: TypedDataDomain;
    types: Record<string, ReadonlyArray<{ readonly name: string; readonly type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

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

/** keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)") */
export const TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
  "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267" as const;

export const AuthorizationSchema = z.object({
  from: AddressSchema,
  to: AddressSchema,
  value: UintStringSchema,
  validAfter: UintStringSchema,
  validBefore: UintStringSchema,
  nonce: Bytes32Schema,
});
export type Authorization = z.infer<typeof AuthorizationSchema>;

/** 65-byte (r, s, v) signature. */
export const SignatureSchema = z.custom<Hex>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{130}$/.test(v), {
  message: "expected a 65-byte hex signature",
});

export function usdcDomain(): TypedDataDomain {
  return USDC_EIP712_DOMAIN;
}

/** The USDC domain separator Circle's contract reports; pinned in @overflow/schemas and checked at boot. */
export function usdcDomainSeparator(): Hex {
  return domainSeparator({ domain: USDC_EIP712_DOMAIN });
}

function message(a: Authorization) {
  return {
    from: a.from,
    to: a.to,
    value: BigInt(a.value),
    validAfter: BigInt(a.validAfter),
    validBefore: BigInt(a.validBefore),
    nonce: a.nonce,
  };
}

/** Exactly the digest USDC (and OverflowTreasury._twaDigest) computes for this authorization. */
export function authorizationDigest(a: Authorization): Hex {
  return hashTypedData({
    domain: USDC_EIP712_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: message(a),
  });
}

/** The agent's node key signs; `from` must be the treasury (USDC asks it via ERC-1271). */
export async function signAuthorization(account: TypedDataSigner, a: Authorization): Promise<Hex> {
  return account.signTypedData({
    domain: USDC_EIP712_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: message(a),
  });
}

export async function recoverAuthorizationSigner(a: Authorization, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({
    domain: USDC_EIP712_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: message(a),
    signature,
  });
}

/** Fresh 32-byte nonce; USDC marks it used after one transfer. Never a counter. */
export function randomNonce(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------- treasury delegations

export const CREATE_CHILD_TYPES = {
  CreateChild: [
    { name: "parentId", type: "uint256" },
    { name: "key", type: "address" },
    { name: "cap", type: "uint256" },
    { name: "maxPerCall", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "restricted", type: "bool" },
    { name: "payeesHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const PAUSE_CHILD_TYPES = {
  PauseChild: [
    { name: "target", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const ChildParamsSchema = z.object({
  parentId: UintStringSchema,
  key: AddressSchema,
  cap: UintStringSchema,
  maxPerCall: UintStringSchema,
  expiry: UintStringSchema,
  restricted: z.boolean(),
  payees: z.array(AddressSchema),
  nonce: UintStringSchema,
  deadline: UintStringSchema,
});
export type ChildParams = z.infer<typeof ChildParamsSchema>;

export const PauseChildSchema = z.object({
  target: UintStringSchema,
  nonce: UintStringSchema,
  deadline: UintStringSchema,
});
export type PauseChild = z.infer<typeof PauseChildSchema>;

/** {"Overflow","1",chainId,treasury}: OverflowTreasury.DELEGATION_DOMAIN_SEPARATOR(). */
export function delegationDomain(treasury: Address, chainId: number = CHAIN_ID): TypedDataDomain {
  return { ...OVERFLOW_DELEGATION_DOMAIN, chainId, verifyingContract: treasury };
}

/** keccak256(abi.encodePacked(address[] payees)), as createChild hashes it. */
export function payeesHash(payees: readonly Address[]): Hex {
  return keccak256(encodePacked(["address[]"], [payees as Address[]]));
}

function childMessage(c: ChildParams) {
  return {
    parentId: BigInt(c.parentId),
    key: c.key,
    cap: BigInt(c.cap),
    maxPerCall: BigInt(c.maxPerCall),
    expiry: BigInt(c.expiry),
    restricted: c.restricted,
    payeesHash: payeesHash(c.payees),
    nonce: BigInt(c.nonce),
    deadline: BigInt(c.deadline),
  };
}

export function createChildDigest(treasury: Address, c: ChildParams, chainId: number = CHAIN_ID): Hex {
  return hashTypedData({
    domain: delegationDomain(treasury, chainId),
    types: CREATE_CHILD_TYPES,
    primaryType: "CreateChild",
    message: childMessage(c),
  });
}

export async function signCreateChild(
  account: TypedDataSigner,
  treasury: Address,
  c: ChildParams,
  chainId: number = CHAIN_ID,
): Promise<Hex> {
  return account.signTypedData({
    domain: delegationDomain(treasury, chainId),
    types: CREATE_CHILD_TYPES,
    primaryType: "CreateChild",
    message: childMessage(c),
  });
}

function pauseMessage(p: PauseChild) {
  return { target: BigInt(p.target), nonce: BigInt(p.nonce), deadline: BigInt(p.deadline) };
}

export function pauseChildDigest(treasury: Address, p: PauseChild, chainId: number = CHAIN_ID): Hex {
  return hashTypedData({
    domain: delegationDomain(treasury, chainId),
    types: PAUSE_CHILD_TYPES,
    primaryType: "PauseChild",
    message: pauseMessage(p),
  });
}

export async function signPauseChild(
  account: TypedDataSigner,
  treasury: Address,
  p: PauseChild,
  chainId: number = CHAIN_ID,
): Promise<Hex> {
  return account.signTypedData({
    domain: delegationDomain(treasury, chainId),
    types: PAUSE_CHILD_TYPES,
    primaryType: "PauseChild",
    message: pauseMessage(p),
  });
}

// ---------------------------------------------------------------- token domain check

/** The only chain reads verifyTokenDomain needs; tests pass a fake. */
export interface TokenReader {
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

export const USDC_DOMAIN_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

export type TokenDomain = { name: string; version: string; decimals: number; domainSeparator: Hex; address: Address };

export class TokenDomainMismatch extends Error {
  constructor(public readonly mismatches: string[], public readonly observed: TokenDomain) {
    super(`USDC domain mismatch: ${mismatches.join("; ")}`);
    this.name = "TokenDomainMismatch";
  }
}

/**
 * Read name(), version(), decimals() and DOMAIN_SEPARATOR() from the token (USDC has no eip712Domain()) and
 * require them to match the pinned USDC constants and the separator viem derives from them. Throws on mismatch.
 */
export async function verifyTokenDomain(client: TokenReader, token: Address = USDC.address): Promise<TokenDomain> {
  const read = (fn: string) => client.readContract({ address: token, abi: USDC_DOMAIN_ABI, functionName: fn });
  const [name, version, decimals, sep] = await Promise.all([read("name"), read("version"), read("decimals"), read("DOMAIN_SEPARATOR")]);
  const observed: TokenDomain = {
    name: String(name),
    version: String(version),
    decimals: Number(decimals),
    domainSeparator: String(sep).toLowerCase() as Hex,
    address: token,
  };
  const m: string[] = [];
  if (token.toLowerCase() !== USDC.address.toLowerCase()) m.push(`address ${token} != ${USDC.address}`);
  if (observed.name !== USDC.name) m.push(`name "${observed.name}" != "${USDC.name}"`);
  if (observed.version !== USDC.version) m.push(`version "${observed.version}" != "${USDC.version}"`);
  if (observed.decimals !== USDC.decimals) m.push(`decimals ${observed.decimals} != ${USDC.decimals}`);
  const expected = usdcDomainSeparator().toLowerCase();
  if (observed.domainSeparator !== expected) m.push(`DOMAIN_SEPARATOR ${observed.domainSeparator} != ${expected}`);
  if (expected !== USDC.domainSeparator.toLowerCase()) m.push(`pinned separator ${USDC.domainSeparator} != derived ${expected}`);
  if (m.length) throw new TokenDomainMismatch(m, observed);
  return observed;
}
