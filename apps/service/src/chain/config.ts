import { AddressSchema, CHAIN_ID, loadDeployments, UintStringSchema, type Address } from "@overflow/schemas";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Indexer configuration: env + deployments/base-sepolia.json. Nothing here
// invents an address or a block; when the inputs are missing the indexer
// stays idle and GET / says why.
// ---------------------------------------------------------------------------

const EnvSchema = z.object({
  BASE_SEPOLIA_RPC_URL: z.url().optional(),
  /** Poll interval in milliseconds. */
  INDEXER_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(2000),
  /** Blocks re-read on every poll to absorb reorgs. */
  INDEXER_REORG_DEPTH: z.coerce.number().int().min(0).max(1000).default(12),
  /** Max blocks per eth_getLogs call (public Base Sepolia RPC caps the range near 200). */
  INDEXER_CHUNK_BLOCKS: z.coerce.number().int().min(1).max(10_000).default(190),
  OVERFLOW_DEPLOYMENTS_PATH: z.string().min(1).optional(),
});

export const IndexerConfigSchema = z.object({
  chainId: z.literal(CHAIN_ID),
  rpcUrl: z.url(),
  treasury: AddressSchema,
  escrowFactory: AddressSchema,
  deployBlock: UintStringSchema,
  pollMs: z.number().int().positive(),
  reorgDepth: z.number().int().min(0),
  chunkBlocks: z.number().int().positive(),
});
export type IndexerConfig = z.infer<typeof IndexerConfigSchema>;

export type IndexerConfigResult = { ok: true; config: IndexerConfig } | { ok: false; reason: string };

/** Drops empty strings so `.env` placeholders read as unset. */
function compact(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "") out[k] = v;
  return out;
}

export async function resolveIndexerConfig(env: NodeJS.ProcessEnv = process.env): Promise<IndexerConfigResult> {
  const parsed = EnvSchema.safeParse(compact(env));
  if (!parsed.success) {
    return { ok: false, reason: `invalid indexer env: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  }
  const e = parsed.data;
  if (!e.BASE_SEPOLIA_RPC_URL) return { ok: false, reason: "BASE_SEPOLIA_RPC_URL is not set" };

  let deployments;
  try {
    deployments = await loadDeployments(e.OVERFLOW_DEPLOYMENTS_PATH);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (deployments.deployBlock === undefined) {
    return { ok: false, reason: "deployments file has no deployBlock; the indexer needs the block to scan from" };
  }
  return {
    ok: true,
    config: IndexerConfigSchema.parse({
      chainId: CHAIN_ID,
      rpcUrl: e.BASE_SEPOLIA_RPC_URL,
      treasury: deployments.treasury as Address,
      escrowFactory: deployments.escrowFactory as Address,
      deployBlock: deployments.deployBlock,
      pollMs: e.INDEXER_POLL_MS,
      reorgDepth: e.INDEXER_REORG_DEPTH,
      chunkBlocks: e.INDEXER_CHUNK_BLOCKS,
    }),
  };
}
