import type { Hex } from "viem";
import { z } from "zod";
import {
  AddressSchema,
  Bytes32Schema,
  IsoDateTimeSchema,
  UintStringSchema,
  USDC_DECIMALS,
} from "./primitives";

/** Base Sepolia chain id. */
export const CHAIN_ID = 84532 as const;

/** Base Sepolia USDC facts (docs/SPEC.md "USDC facts (verified)"). */
export const USDC = {
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  name: "USDC",
  version: "2",
  decimals: USDC_DECIMALS,
  chainId: CHAIN_ID,
  domainSeparator: "0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818",
  /** transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes) */
  transferWithAuthorizationSelector: "0xcf092995",
} as const satisfies {
  address: `0x${string}`;
  name: string;
  version: string;
  decimals: number;
  chainId: number;
  domainSeparator: Hex;
  transferWithAuthorizationSelector: Hex;
};

/** EIP-712 domain the USDC contract signs under. */
export const USDC_EIP712_DOMAIN = {
  name: USDC.name,
  version: USDC.version,
  chainId: CHAIN_ID,
  verifyingContract: USDC.address,
} as const;

/** Treasury delegation domain; `verifyingContract` is the deployed treasury. */
export const OVERFLOW_DELEGATION_DOMAIN = {
  name: "Overflow",
  version: "1",
  chainId: CHAIN_ID,
} as const;

export const BASE_SEPOLIA_EXPLORER = "https://sepolia.basescan.org" as const;

export type ExplorerKind = "tx" | "address" | "block";

/** Basescan link for a tx hash, address or block number on Base Sepolia. */
export function explorerUrl(kind: ExplorerKind, value: string | number | bigint): string {
  return `${BASE_SEPOLIA_EXPLORER}/${kind}/${String(value)}`;
}

// ---------------------------------------------------------------------------
// deployments/base-sepolia.json (written by the deploy script, P1.2)
// ---------------------------------------------------------------------------

export const DEPLOYMENTS_RELATIVE_PATH = "deployments/base-sepolia.json" as const;

export const DeploymentsSchema = z.object({
  chainId: z.literal(CHAIN_ID),
  treasury: AddressSchema,
  escrowFactory: AddressSchema,
  usdc: AddressSchema.default(USDC.address),
  deployer: AddressSchema.optional(),
  deployBlock: UintStringSchema.optional(),
  deployedAt: IsoDateTimeSchema.optional(),
  /** Deploy tx hashes keyed by contract name. */
  txHashes: z.record(z.string(), Bytes32Schema).optional(),
});
export type Deployments = z.infer<typeof DeploymentsSchema>;

/** Pure: validate an already-parsed JSON value. */
export function parseDeployments(json: unknown): Deployments {
  return DeploymentsSchema.parse(json);
}

/**
 * Default location: `<repo root>/deployments/base-sepolia.json`, resolved from this file
 * (packages/schemas/src/chain.ts). Override with OVERFLOW_DEPLOYMENTS_PATH.
 */
export async function defaultDeploymentsPath(): Promise<string> {
  const env = globalThis.process?.env?.OVERFLOW_DEPLOYMENTS_PATH;
  if (env) return env;
  const { fileURLToPath } = await import("node:url");
  const { resolve, dirname } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../..", DEPLOYMENTS_RELATIVE_PATH);
}

/**
 * Read and validate the deployments file. Node only; `node:fs` is imported
 * dynamically so this module stays safe to import from browser bundles.
 */
export async function loadDeployments(path?: string): Promise<Deployments> {
  const target = path ?? (await defaultDeploymentsPath());
  const { readFile } = await import("node:fs/promises");
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (err) {
    throw new Error(
      `deployments file not found at ${target} (written by the deploy script, P1.2): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return parseDeployments(JSON.parse(raw));
}
