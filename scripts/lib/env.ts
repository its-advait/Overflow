import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { CHAIN_ID } from "@overflow/schemas/chain";

/** Repo root, resolved from scripts/lib/env.ts. */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Load <repo>/.env into process.env if present (Node >= 20.12). Existing variables win. */
export function loadEnv(): void {
  const file = resolve(repoRoot(), ".env");
  if (!existsSync(file)) return;
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env var ${name} (see .env.example)`);
    process.exit(2);
  }
  return v;
}

export function publicClient() {
  return createPublicClient({ chain: baseSepolia, transport: http(requireEnv("BASE_SEPOLIA_RPC_URL")) });
}
export type Client = ReturnType<typeof publicClient>;

export async function assertChainId(client: Client): Promise<void> {
  const id = await client.getChainId();
  if (id !== CHAIN_ID) {
    console.error(`RPC is chain ${id}, expected Base Sepolia ${CHAIN_ID}`);
    process.exit(2);
  }
}

/** Address of the deployer. Env slots may hold an address (keystore flow) or a 64-hex key (derive). */
export async function deployerAddress(): Promise<`0x${string}`> {
  const explicit = process.env["DEPLOYER_ADDRESS"];
  if (explicit) return explicit as `0x${string}`;
  const slot = process.env["DEPLOYER_PRIVATE_KEY"] ?? "";
  if (/^0x[0-9a-fA-F]{40}$/.test(slot)) return slot as `0x${string}`;
  if (/^0x[0-9a-fA-F]{64}$/.test(slot)) {
    const { privateKeyToAccount } = await import("viem/accounts");
    return privateKeyToAccount(slot as `0x${string}`).address;
  }
  console.error("set DEPLOYER_ADDRESS (or DEPLOYER_PRIVATE_KEY) in .env");
  process.exit(2);
}
