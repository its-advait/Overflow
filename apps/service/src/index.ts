import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { CHAIN_ID, loadDeployments, PACKAGE_NAME as SCHEMAS } from "@overflow/schemas";
import { verifyBoot } from "./chain/boot";
import { resolveSigner } from "@overflow/payment-client/keystore";
import { viemChainClient } from "./chain/client";
import { loadEnv, readConfig } from "./config";
import { createFacilitatorApp } from "./facilitator/app";
import { createBus, createLogPoller } from "./facilitator/events";
import { createSweepReconciler, MemoryExceptions, MemoryLedger, MemoryPurchaseIndex } from "./reconciliation/sweeps";
import { createRelayer } from "./facilitator/relayer";
import { MemoryStore } from "./facilitator/store";
import { ORCHESTRATION_STATUS } from "./orchestration/index.js";
import { SELLERS_STATUS } from "./sellers/index.js";
import { API_STATUS } from "./api/index.js";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

async function main(): Promise<void> {
  loadEnv();
  const config = readConfig();
  const deployments = await loadDeployments(config.deploymentsPath);
  // Signer: a Foundry keystore decrypted in memory (RELAYER_ACCOUNT + RELAYER_PASSWORD_FILE) or a dev key. Never logged.
  const signer = resolveSigner({ ...config.relayer, label: "RELAYER" });
  const account = signer.account;
  const client = viemChainClient(config.rpcUrl, account);

  // Fail loudly before serving anything.
  const boot = await verifyBoot(client, deployments);
  log(`[boot] chain ${boot.chainId}, USDC ${boot.token.address} "${boot.token.name}" v${boot.token.version} separator ${boot.token.domainSeparator}`);
  log(`[boot] treasury ${boot.treasury}, escrowFactory ${boot.escrowFactory ?? "none"}, head block ${boot.blockNumber}`);
  const ethWei = await client.getBalance(account.address);
  log(`[boot] relayer ${account.address} (${signer.source}) holds ${ethWei} wei for gas (relayer never holds USDC)`);
  if (ethWei === 0n) log("[boot] WARNING: relayer has no ETH; every relay will fail");
  if (config.demoMode) log("[boot] DEMO_MODE=true: /demo/bypass and forceBroadcast enabled (x-demo-token required); SIMULATED flows are labeled");

  const bus = createBus();
  const poller = createLogPoller({ client, treasury: boot.treasury, bus, fromBlock: boot.blockNumber, intervalMs: config.eventsPollMs, log });
  const facilitator = createFacilitatorApp({
    client,
    relayer: createRelayer({ client, address: account.address, log }),
    store: new MemoryStore(),
    bus,
    deployments,
    treasury: boot.treasury,
    usdc: deployments.usdc,
    demoMode: config.demoMode,
    ...(config.demoToken ? { demoToken: config.demoToken } : {}),
    now: () => new Date(),
    log,
  });

  const app = new Hono();
  app.get("/", (c) =>
    c.json({
      service: "@overflow/service",
      chainId: CHAIN_ID,
      treasury: boot.treasury,
      modules: { facilitator: "live", api: API_STATUS, orchestration: ORCHESTRATION_STATUS, sellers: SELLERS_STATUS },
      dependsOn: [SCHEMAS],
    }),
  );
  app.route("/", facilitator);

  poller.start();
  if (boot.escrowFactory) {
    // Books late arrivals into closed escrows and their sweep() recoveries; in-memory ledger until Postgres lands.
    createSweepReconciler({
      client,
      factory: boot.escrowFactory,
      usdc: deployments.usdc,
      treasury: boot.treasury,
      bus,
      purchases: new MemoryPurchaseIndex(),
      ledger: new MemoryLedger(),
      exceptions: new MemoryExceptions(),
      fromBlock: deployments.deployBlock ? BigInt(deployments.deployBlock) : boot.blockNumber,
      intervalMs: config.eventsPollMs * 2,
      log,
    }).start();
  }
  serve({ fetch: app.fetch, port: config.port }, (info) => log(`[service] listening on http://localhost:${info.port} (facilitator routes at /)`));
}

main().catch((err) => {
  console.error(`[service] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
