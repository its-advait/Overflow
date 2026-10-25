import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { presentEnv, resolveNodeSigner, type CdpClientLike, type ResolvedNodeSigner } from "@overflow/payment-client/signers";
import { AddressSchema, CHAIN_ID } from "@overflow/schemas";
import { z } from "zod";

/** Public Base Sepolia RPC, used only when BASE_SEPOLIA_RPC_URL is unset (rate limited; a stderr warning says so). */
export const PUBLIC_RPC_FALLBACK = "https://sepolia.base.org";

/** <repo>/.env: three levels up from packages/overflow-mcp/{src,dist}/*. OVERFLOW_ENV_FILE overrides. */
export function envFilePath(): string {
  return process.env["OVERFLOW_ENV_FILE"] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env");
}

/** Load the repo .env if present (Node >= 20.12). Variables already in the environment win. Never logs values. */
export function loadEnv(): string | null {
  const file = envFilePath();
  if (!existsSync(file)) return null;
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
  return file;
}

/**
 * Service-side settings. The node signer's variables (NODE_SIGNER, NODE_PRIVATE_KEY, NODE_ACCOUNT,
 * NODE_PASSWORD_FILE, CDP_ACCOUNT_NAME, CDP_ACCOUNT_ADDRESS and the CDP credentials by name) are validated by
 * `resolveNodeSigner` in @overflow/payment-client/signers.
 */
export const EnvSchema = z
  .object({
    SERVICE_URL: z.url().default("http://localhost:4000"),
    /** Optional pin: must equal the treasury the service reports at /health. */
    TREASURY: AddressSchema.optional(),
    BASE_SEPOLIA_RPC_URL: z.url().optional(),
    /** Only Base Sepolia (84532) exists for Overflow; any other value is refused. */
    CHAIN_ID: z.coerce.number().int().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.CHAIN_ID !== undefined && e.CHAIN_ID !== CHAIN_ID) {
      ctx.addIssue({ code: "custom", path: ["CHAIN_ID"], message: `CHAIN_ID must be ${CHAIN_ID} (Base Sepolia); got ${e.CHAIN_ID}` });
    }
  });

export interface Config {
  serviceUrl: string;
  treasuryPin: `0x${string}` | null;
  rpcUrl: string;
  rpcSource: "BASE_SEPOLIA_RPC_URL" | "public fallback";
  /** `kind` env-key / keystore (NODE_SIGNER=env, default) or cdp (NODE_SIGNER=cdp, a CDP server account). */
  signer: ResolvedNodeSigner;
}

export interface ReadConfigOptions {
  /** CDP client factory for tests; production loads `@coinbase/cdp-sdk` only when NODE_SIGNER=cdp. */
  cdp?: () => Promise<CdpClientLike> | CdpClientLike;
}

export async function readConfig(env: Record<string, string | undefined> = process.env, opts: ReadConfigOptions = {}): Promise<Config> {
  const present = presentEnv(env);
  const e = EnvSchema.parse(present);
  const signer = await resolveNodeSigner(present, { label: "NODE", ...(opts.cdp ? { cdp: opts.cdp } : {}) });
  return {
    serviceUrl: e.SERVICE_URL.replace(/\/+$/, ""),
    treasuryPin: e.TREASURY ?? null,
    rpcUrl: e.BASE_SEPOLIA_RPC_URL ?? PUBLIC_RPC_FALLBACK,
    rpcSource: e.BASE_SEPOLIA_RPC_URL ? "BASE_SEPOLIA_RPC_URL" : "public fallback",
    signer,
  };
}
