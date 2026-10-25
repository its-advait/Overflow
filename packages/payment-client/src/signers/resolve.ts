import { AddressSchema } from "@overflow/schemas";
import { z } from "zod";
import { KeystoreError } from "../keystore";
import { CdpAccountNameSchema, cdpSigner } from "./cdp";
import { envKeySigner } from "./env-key";
import type { CdpClientLike, ResolvedNodeSigner } from "./types";

/**
 * One switch for where a node key lives:
 *   <LABEL>_SIGNER=env (default): <LABEL>_PRIVATE_KEY (64-hex) or <LABEL>_ACCOUNT + <LABEL>_PASSWORD_FILE (Foundry keystore).
 *   <LABEL>_SIGNER=cdp:           a CDP server account named CDP_ACCOUNT_NAME, optionally pinned to CDP_ACCOUNT_ADDRESS,
 *                                 with CDP_API_KEY_ID (or CDP_API_KEY_NAME), CDP_API_KEY_SECRET and CDP_WALLET_SECRET set.
 * Credentials are checked by name only and never read here; the SDK reads them itself.
 */

export const NodeSignerModeSchema = z.enum(["env", "cdp"]);
export type NodeSignerMode = z.infer<typeof NodeSignerModeSchema>;

export const KeyOrAddressSchema = z
  .string()
  .regex(/^(0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40})$/, "must be a 0x 64-hex key, or the key's address when it lives in a Foundry keystore");

/** The CDP SDK's own credential variables. Presence is checked by name; values are never read by this package. */
export const CDP_CREDENTIAL_ENV = {
  apiKeyId: ["CDP_API_KEY_ID", "CDP_API_KEY_NAME"],
  apiKeySecret: ["CDP_API_KEY_SECRET"],
  walletSecret: ["CDP_WALLET_SECRET"],
} as const;

export interface ResolveNodeSignerOptions {
  /** Env prefix, e.g. "NODE" reads NODE_SIGNER / NODE_PRIVATE_KEY / NODE_ACCOUNT / NODE_PASSWORD_FILE. */
  label?: string;
  /** CDP client factory (tests inject a fake); only called when the mode is `cdp`. */
  cdp?: () => Promise<CdpClientLike> | CdpClientLike;
  keystoresDir?: string;
}

/** Empty strings (an unset line in .env) count as absent. */
export function presentEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((kv): kv is [string, string] => kv[1] !== undefined && kv[1].trim() !== ""));
}

/** Names of the CDP credential variables that are missing, grouped by role. Empty when all are present. */
export function missingCdpCredentials(env: Record<string, string | undefined>): string[] {
  const e = presentEnv(env);
  const missing: string[] = [];
  for (const names of Object.values(CDP_CREDENTIAL_ENV)) {
    if (!names.some((n) => n in e)) missing.push(names.join(" or "));
  }
  return missing;
}

export async function resolveNodeSigner(
  env: Record<string, string | undefined>,
  opts: ResolveNodeSignerOptions = {},
): Promise<ResolvedNodeSigner> {
  const label = opts.label ?? "NODE";
  const e = presentEnv(env);
  const modeRaw = e[`${label}_SIGNER`] ?? "env";
  const mode = NodeSignerModeSchema.safeParse(modeRaw);
  if (!mode.success) throw new KeystoreError(`${label}_SIGNER must be "env" or "cdp", got "${modeRaw}"`);

  if (mode.data === "env") {
    const slot = e[`${label}_PRIVATE_KEY`];
    if (slot !== undefined) {
      const parsed = KeyOrAddressSchema.safeParse(slot);
      if (!parsed.success) throw new KeystoreError(`${label}_PRIVATE_KEY ${parsed.error.issues[0]?.message ?? "is invalid"}`);
    }
    return envKeySigner({
      keyOrAddress: slot,
      account: e[`${label}_ACCOUNT`],
      passwordFile: e[`${label}_PASSWORD_FILE`],
      keystoresDir: opts.keystoresDir,
      label,
    });
  }

  const missing = missingCdpCredentials(e);
  if (missing.length > 0) {
    throw new KeystoreError(
      `${label}_SIGNER=cdp needs ${missing.join(", ")} in the environment (CDP portal: API key + Wallet Secret). Values are read by the CDP SDK only.`,
    );
  }
  const accountName = e["CDP_ACCOUNT_NAME"];
  if (!accountName) throw new KeystoreError(`${label}_SIGNER=cdp needs CDP_ACCOUNT_NAME (the CDP server account that holds the node key)`);
  const nameCheck = CdpAccountNameSchema.safeParse(accountName);
  if (!nameCheck.success) throw new KeystoreError(`CDP_ACCOUNT_NAME: ${nameCheck.error.issues[0]?.message ?? "invalid"}`);
  const pin = e["CDP_ACCOUNT_ADDRESS"];
  const expectedAddress = pin !== undefined ? AddressSchema.parse(pin) : undefined;
  const client = opts.cdp ? await opts.cdp() : undefined;
  return cdpSigner({ accountName: nameCheck.data, expectedAddress, client });
}
