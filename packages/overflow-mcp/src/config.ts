import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSigner, type ResolvedSigner } from "@overflow/payment-client/keystore";
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

const KeyOrAddress = z
  .string()
  .regex(/^(0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40})$/, "NODE_PRIVATE_KEY must be a 0x 64-hex key, or the node key's address when the key lives in a Foundry keystore");

export const EnvSchema = z
  .object({
    SERVICE_URL: z.url().default("http://localhost:4000"),
    /** Optional pin: must equal the treasury the service reports at /health. */
    TREASURY: AddressSchema.optional(),
    BASE_SEPOLIA_RPC_URL: z.url().optional(),
    /** Only Base Sepolia (84532) exists for Overflow; any other value is refused. */
    CHAIN_ID: z.coerce.number().int().optional(),
    /** 64-hex key (dev), or just the address when NODE_ACCOUNT names a keystore. Never logged. */
    NODE_PRIVATE_KEY: KeyOrAddress.optional(),
    /** Foundry keystore name (`cast wallet list`) or absolute path; decrypted in memory at boot. */
    NODE_ACCOUNT: z.string().min(1).optional(),
    /** chmod-600 file holding that keystore's password. */
    NODE_PASSWORD_FILE: z.string().min(1).optional(),
    /** Not implemented: CDP accounts signing arbitrary EIP-712 is unconfirmed (docs/SPEC.md). Set = refuse to start. */
    NODE_CDP_ACCOUNT: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.CHAIN_ID !== undefined && e.CHAIN_ID !== CHAIN_ID) {
      ctx.addIssue({ code: "custom", path: ["CHAIN_ID"], message: `CHAIN_ID must be ${CHAIN_ID} (Base Sepolia); got ${e.CHAIN_ID}` });
    }
    if (e.NODE_CDP_ACCOUNT) {
      ctx.addIssue({
        code: "custom",
        path: ["NODE_CDP_ACCOUNT"],
        message: "a CDP account as node signer is not implemented yet (CDP signing of arbitrary EIP-712 is unconfirmed); use NODE_PRIVATE_KEY or NODE_ACCOUNT + NODE_PASSWORD_FILE",
      });
    }
  });

export interface Config {
  serviceUrl: string;
  treasuryPin: `0x${string}` | null;
  rpcUrl: string;
  rpcSource: "BASE_SEPOLIA_RPC_URL" | "public fallback";
  signer: ResolvedSigner;
}

/** Empty strings (an unset line in .env) count as absent. */
function present(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((kv): kv is [string, string] => kv[1] !== undefined && kv[1] !== ""));
}

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(present(env));
  const signer = resolveSigner({ keyOrAddress: e.NODE_PRIVATE_KEY, account: e.NODE_ACCOUNT, passwordFile: e.NODE_PASSWORD_FILE, label: "NODE" });
  return {
    serviceUrl: e.SERVICE_URL.replace(/\/+$/, ""),
    treasuryPin: e.TREASURY ?? null,
    rpcUrl: e.BASE_SEPOLIA_RPC_URL ?? PUBLIC_RPC_FALLBACK,
    rpcSource: e.BASE_SEPOLIA_RPC_URL ? "BASE_SEPOLIA_RPC_URL" : "public fallback",
    signer,
  };
}
