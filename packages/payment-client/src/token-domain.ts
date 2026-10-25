import { domainSeparator, getAddress, parseAbi, type Address, type Hex } from "viem";
import { CHAIN_ID, USDC } from "@overflow/schemas";
import { TokenDomainMismatchError, type DomainMismatch } from "./errors";

// ---------------------------------------------------------------------------
// Boot-time check (docs/SPEC.md "Domain check at boot"): USDC has no eip712Domain(), so read
// name(), version(), decimals() and DOMAIN_SEPARATOR() and compare with the pinned facts.
// ---------------------------------------------------------------------------

export const USDC_DOMAIN_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

/** Structural subset of viem's PublicClient. */
export interface TokenDomainReader {
  readContract(args: {
    address: Address;
    abi: typeof USDC_DOMAIN_ABI;
    functionName: "name" | "version" | "decimals" | "DOMAIN_SEPARATOR";
  }): Promise<unknown>;
  getChainId?(): Promise<number>;
}

export interface TokenDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export interface VerifiedTokenDomain {
  domain: TokenDomain;
  decimals: number;
  domainSeparator: Hex;
}

export interface VerifyTokenDomainOptions {
  /** Defaults to the pinned Base Sepolia USDC address. */
  token?: Address;
}

/** The pinned USDC EIP-712 domain. */
export const USDC_DOMAIN: TokenDomain = {
  name: USDC.name,
  version: USDC.version,
  chainId: CHAIN_ID,
  verifyingContract: USDC.address,
};

/**
 * Read the live token's domain facts and throw TokenDomainMismatchError unless they are
 * exactly "USDC", "2", 6 decimals and the separator computed from {USDC, 2, 84532, token}.
 */
export async function verifyTokenDomain(
  publicClient: TokenDomainReader,
  options: VerifyTokenDomainOptions = {},
): Promise<VerifiedTokenDomain> {
  const token = getAddress(options.token ?? USDC.address);
  const read = (functionName: "name" | "version" | "decimals" | "DOMAIN_SEPARATOR") =>
    publicClient.readContract({ address: token, abi: USDC_DOMAIN_ABI, functionName });

  const [name, version, decimals, separator, chainId] = await Promise.all([
    read("name"),
    read("version"),
    read("decimals"),
    read("DOMAIN_SEPARATOR"),
    publicClient.getChainId ? publicClient.getChainId() : Promise.resolve(CHAIN_ID),
  ]);

  const expectedSeparator = domainSeparator({
    domain: { name: USDC.name, version: USDC.version, chainId: CHAIN_ID, verifyingContract: token },
  });

  const mismatches: DomainMismatch[] = [];
  if (chainId !== CHAIN_ID) mismatches.push({ field: "chainId", expected: String(CHAIN_ID), actual: String(chainId) });
  if (name !== USDC.name) mismatches.push({ field: "name", expected: USDC.name, actual: String(name) });
  if (version !== USDC.version) mismatches.push({ field: "version", expected: USDC.version, actual: String(version) });
  if (Number(decimals) !== USDC.decimals || typeof decimals !== "number") {
    mismatches.push({ field: "decimals", expected: String(USDC.decimals), actual: String(decimals) });
  }
  if (typeof separator !== "string" || separator.toLowerCase() !== expectedSeparator.toLowerCase()) {
    mismatches.push({ field: "DOMAIN_SEPARATOR", expected: expectedSeparator, actual: String(separator) });
  }
  if (token.toLowerCase() === USDC.address.toLowerCase() && expectedSeparator.toLowerCase() !== USDC.domainSeparator.toLowerCase()) {
    // Cannot happen unless the pinned constants disagree with each other; keep the check anyway.
    mismatches.push({ field: "pinned DOMAIN_SEPARATOR", expected: USDC.domainSeparator, actual: expectedSeparator });
  }
  if (mismatches.length > 0) throw new TokenDomainMismatchError(mismatches);

  return {
    domain: { name: USDC.name, version: USDC.version, chainId: CHAIN_ID, verifyingContract: token },
    decimals: USDC.decimals,
    domainSeparator: separator as Hex,
  };
}
