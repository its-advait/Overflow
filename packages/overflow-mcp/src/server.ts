// stdio MCP server entry. stdout is the JSON-RPC stream: nothing else may ever write to it.
// eslint-disable-next-line no-console
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { CHAIN_ID } from "@overflow/schemas";
import { viemChainReader } from "./chain";
import { loadEnv, PUBLIC_RPC_FALLBACK, readConfig } from "./config";
import { assertHealth, fetchHealth } from "./facilitator";
import { createServer } from "./mcp";
import { TOOL_NAMES } from "./tools";

const log = (line: string): void => console.error(`${new Date().toISOString()} [overflow-mcp] ${line}`);

async function main(): Promise<void> {
  const envFile = loadEnv();
  log(envFile ? `env loaded from ${envFile} (values never logged)` : "no .env file found; using the process environment");
  const config = await readConfig();
  if (config.rpcSource === "public fallback") log(`WARNING: BASE_SEPOLIA_RPC_URL unset; reading the chain through ${PUBLIC_RPC_FALLBACK} (rate limited)`);

  const health = await fetchHealth(fetch, config.serviceUrl);
  const treasury = assertHealth(health, config.treasuryPin);
  log(`service ${config.serviceUrl}: chain ${health.chainId}, treasury ${treasury}, USDC ${health.usdc}`);
  log(`node signer ${config.signer.address} (${config.signer.kind}: ${config.signer.source}); chain ${CHAIN_ID} reads via ${config.rpcSource}`);

  const server = createServer({
    fetch,
    chain: viemChainReader(config.rpcUrl, treasury),
    signer: config.signer.signer,
    signerSource: config.signer.source,
    treasury,
    serviceUrl: config.serviceUrl,
    now: () => Math.floor(Date.now() / 1000),
  });
  await server.connect(new StdioServerTransport());
  log(`ready on stdio with tools ${TOOL_NAMES.join(", ")}; only overflow_pay can sign for a seller`);
}

main().catch((err) => {
  console.error(`[overflow-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
