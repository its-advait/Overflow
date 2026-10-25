import type { Address, Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { simulatedBytes32 } from "@overflow/recourse-crypto";
import { Bytes32Schema } from "@overflow/schemas";

// ---------------------------------------------------------------------------
// SIMULATED "state registry feed" that signs every dataset record. The default
// key is the same label-derived key as the recourse-crypto golden vectors, so
// the feed is one identity everywhere. It never holds funds.
// ---------------------------------------------------------------------------

export const SOURCE_SIGNER_LABEL = "SIMULATED state registry feed";
export const SIMULATED_SOURCE_SIGNER_KEY: Hex = simulatedBytes32("source-signer");
export const SIMULATED_SOURCE_SIGNER_ADDRESS: Address = privateKeyToAddress(SIMULATED_SOURCE_SIGNER_KEY);

export interface ResolvedSigner {
  privateKey: Hex;
  address: Address;
  /** True when the key is the committed default; false when SOURCE_SIGNER_KEY overrode it. */
  isDefault: boolean;
}

/** SOURCE_SIGNER_KEY from the environment, else the simulated default. */
export function resolveSourceSignerKey(env: Record<string, string | undefined> = process.env): ResolvedSigner {
  const raw = env["SOURCE_SIGNER_KEY"]?.trim();
  if (!raw) {
    return { privateKey: SIMULATED_SOURCE_SIGNER_KEY, address: SIMULATED_SOURCE_SIGNER_ADDRESS, isDefault: true };
  }
  const privateKey = Bytes32Schema.parse(raw);
  return { privateKey, address: privateKeyToAddress(privateKey), isDefault: privateKey.toLowerCase() === SIMULATED_SOURCE_SIGNER_KEY };
}
