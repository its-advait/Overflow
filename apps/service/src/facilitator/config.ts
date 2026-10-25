import { AddressSchema, CHAIN_ID, loadDeployments, type Address } from "@overflow/schemas";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { z } from "zod";
import { createChainFacilitator, viemSettleChain, type Facilitator } from "./settle.js";

// ---------------------------------------------------------------------------
// Facilitator configuration: env + deployments/base-sepolia.json. As with the
// indexer, nothing here invents an address; when inputs are missing the
// facilitator is absent and every paid retry at the seller answers 503.
// ---------------------------------------------------------------------------

const EnvSchema = z.object({
  BASE_SEPOLIA_RPC_URL: z.url().optional(),
  RELAYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte private key")
    .optional(),
  OVERFLOW_DEPLOYMENTS_PATH: z.string().min(1).optional(),
});

export type FacilitatorConfigResult =
  | { ok: true; treasury: Address; relayer: Address; rpcUrl: string; create(): Facilitator }
  | { ok: false; reason: string };

function compact(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "") out[k] = v;
  return out;
}

export async function resolveFacilitatorConfig(env: NodeJS.ProcessEnv = process.env): Promise<FacilitatorConfigResult> {
  const parsed = EnvSchema.safeParse(compact(env));
  if (!parsed.success) {
    return { ok: false, reason: `invalid facilitator env: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  }
  const e = parsed.data;
  if (!e.BASE_SEPOLIA_RPC_URL) return { ok: false, reason: "BASE_SEPOLIA_RPC_URL is not set" };
  if (!e.RELAYER_PRIVATE_KEY) return { ok: false, reason: "RELAYER_PRIVATE_KEY is not set" };
  let treasury: Address;
  try {
    treasury = AddressSchema.parse((await loadDeployments(e.OVERFLOW_DEPLOYMENTS_PATH)).treasury);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const relayer = privateKeyToAccount(e.RELAYER_PRIVATE_KEY as Hex);
  const rpcUrl = e.BASE_SEPOLIA_RPC_URL;
  return {
    ok: true,
    treasury,
    relayer: relayer.address,
    rpcUrl,
    create() {
      const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
      const walletClient = createWalletClient({ account: relayer, chain: baseSepolia, transport: http(rpcUrl) });
      return createChainFacilitator({
        treasury,
        chain: viemSettleChain({
          publicClient: publicClient as unknown as Parameters<typeof viemSettleChain>[0]["publicClient"],
          walletClient: walletClient as unknown as Parameters<typeof viemSettleChain>[0]["walletClient"],
          relayer,
        }),
      });
    },
  };
}

/** Fails loudly on the wrong network before the first settle(). */
export async function assertFacilitatorChain(rpcUrl: string): Promise<void> {
  const id = await createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) }).getChainId();
  if (id !== CHAIN_ID) throw new Error(`facilitator RPC is chain ${id}, expected ${CHAIN_ID}`);
}

export function facilitatorStatus(result: FacilitatorConfigResult): string {
  return result.ok ? `settle() via relayer ${result.relayer} on treasury ${result.treasury}` : `idle: ${result.reason}`;
}
