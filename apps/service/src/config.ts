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

const PrivateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "RELAYER_PRIVATE_KEY must be a 0x-prefixed 64-hex key");

export const ConfigSchema = z
  .object({
    BASE_SEPOLIA_RPC_URL: z.url(),
    RELAYER_PRIVATE_KEY: PrivateKey,
    SERVICE_URL: z.url().default("http://localhost:4000"),
    DEMO_MODE: z.string().optional(),
    DEMO_TOKEN: z.string().min(16, "DEMO_TOKEN must be at least 16 characters").optional(),
    EVENTS_POLL_MS: z.coerce.number().int().min(500).default(4000),
    OVERFLOW_DEPLOYMENTS_PATH: z.string().optional(),
  })
  .transform((e) => ({
    rpcUrl: e.BASE_SEPOLIA_RPC_URL,
    relayerKey: e.RELAYER_PRIVATE_KEY as `0x${string}`,
    port: Number(new URL(e.SERVICE_URL).port || 4000),
    demoMode: e.DEMO_MODE === "true",
    demoToken: e.DEMO_TOKEN,
    eventsPollMs: e.EVENTS_POLL_MS,
    deploymentsPath: e.OVERFLOW_DEPLOYMENTS_PATH,
  }))
  .refine((c) => !c.demoMode || !!c.demoToken, { message: "DEMO_TOKEN is required when DEMO_MODE=true" });

export type Config = z.infer<typeof ConfigSchema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = ConfigSchema.safeParse(env);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ");
    throw new Error(`invalid service configuration: ${issues}`);
  }
  return r.data;
}
