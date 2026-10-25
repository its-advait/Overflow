import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Repo root from apps/service/src. */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** Load <repo>/.env into process.env when present; existing variables win. Values are never logged. */
export function loadEnv(): void {
  const file = resolve(repoRoot(), ".env");
  if (!existsSync(file)) return;
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
}

const KeyOrAddress = z.string().regex(/^(0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40})?$/, "RELAYER_PRIVATE_KEY must be a 0x 64-hex key, or the relayer's address when the key lives in a Foundry keystore");

/** `.env.example` ships `NAME=` lines; an empty value means "use the default", not 0. */
const blankAsUnset = <S extends z.ZodType>(schema: S) => z.preprocess((v) => (v === "" ? undefined : v), schema);

export const ConfigSchema = z
  .object({
    BASE_SEPOLIA_RPC_URL: z.url(),
    /** 64-hex key (dev), or just the address when RELAYER_ACCOUNT names a keystore. Never logged. */
    RELAYER_PRIVATE_KEY: KeyOrAddress.optional(),
    /** Foundry keystore name (`cast wallet list`) or absolute path; decrypted in memory at boot. */
    RELAYER_ACCOUNT: z.string().min(1).optional(),
    /** chmod-600 file holding that keystore's password. */
    RELAYER_PASSWORD_FILE: z.string().min(1).optional(),
    SERVICE_URL: z.url().default("http://localhost:4000"),
    DEMO_MODE: z.string().optional(),
    DEMO_TOKEN: z.string().min(16, "DEMO_TOKEN must be at least 16 characters").optional(),
    EVENTS_POLL_MS: z.coerce.number().int().min(500).default(4000),
    OVERFLOW_DEPLOYMENTS_PATH: z.string().optional(),
    /** Step 4: a "buy" verdict below this confidence opens a LOW_CONFIDENCE_SAMPLE exception instead of signing. */
    SAMPLE_CONFIDENCE_MIN: blankAsUnset(z.coerce.number().min(0).max(1).default(0.7)),
    /** Step 4: chunk keys requested per pre-funding sample (the seller caps it at 64). */
    SAMPLE_SIZE: blankAsUnset(z.coerce.number().int().min(1).max(64).default(20)),
    /** SCRIPTED mode: `record` saves every model answer to DEMO_SCRIPTED_FILE; `replay` answers from it and never calls the API. */
    DEMO_SCRIPTED: blankAsUnset(z.enum(["record", "replay"]).optional()),
    /** Recording path, relative to the repo root (default data/scripted/honest-seller.json). */
    DEMO_SCRIPTED_FILE: blankAsUnset(z.string().min(1).default("data/scripted/honest-seller.json")),
  })
  .transform((e) => ({
    rpcUrl: e.BASE_SEPOLIA_RPC_URL,
    relayer: { keyOrAddress: e.RELAYER_PRIVATE_KEY, account: e.RELAYER_ACCOUNT, passwordFile: e.RELAYER_PASSWORD_FILE },
    port: Number(new URL(e.SERVICE_URL).port || 4000),
    demoMode: e.DEMO_MODE === "true",
    demoToken: e.DEMO_TOKEN,
    eventsPollMs: e.EVENTS_POLL_MS,
    deploymentsPath: e.OVERFLOW_DEPLOYMENTS_PATH,
    sampleConfidenceMin: e.SAMPLE_CONFIDENCE_MIN,
    sampleSize: e.SAMPLE_SIZE,
    scripted: { mode: e.DEMO_SCRIPTED ?? ("off" as const), file: resolve(repoRoot(), e.DEMO_SCRIPTED_FILE) },
  }))
  .refine((c) => !c.demoMode || !!c.demoToken, { message: "DEMO_TOKEN is required when DEMO_MODE=true" })
  .refine((c) => /^0x[0-9a-fA-F]{64}$/.test(c.relayer.keyOrAddress ?? "") || (!!c.relayer.account && !!c.relayer.passwordFile), {
    message: "relayer signer: set RELAYER_ACCOUNT + RELAYER_PASSWORD_FILE (Foundry keystore), or a 64-hex RELAYER_PRIVATE_KEY",
  });

export type Config = z.infer<typeof ConfigSchema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = ConfigSchema.safeParse(env);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ");
    throw new Error(`invalid service configuration: ${issues}`);
  }
  return r.data;
}
