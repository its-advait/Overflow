import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { createDatabase, seed } from "@overflow/database";
import { oracleModelFromEnv } from "@overflow/oracle";
import { resolveSigner } from "@overflow/payment-client/keystore";
import { CHAIN_ID, formatUsdc, loadDeployments, PACKAGE_NAME as SCHEMAS, type Address } from "@overflow/schemas";
import { erc20Abi } from "viem";
import { createApp } from "./api/index.js";
import { verifyBoot } from "./chain/boot";
import { viemChainClient } from "./chain/client";
import { createActivityBus, createIndexer, createLogSource, readTreasurySnapshot, resolveIndexerConfig, type Indexer } from "./chain/index.js";
import { loadEnv, readConfig } from "./config";
import { createFacilitatorApp } from "./facilitator/app";
import { createBus, createLogPoller } from "./facilitator/events";
import { facilitatorViaApp } from "./facilitator/in-process.js";
import { createRelayer } from "./facilitator/relayer";
import { MemoryStore } from "./facilitator/store";
import { createReconciliation, type Reconciliation } from "./ledger/index.js";
import {
  AGENT_KEYS_LIMITATION,
  createMissionRunner,
  createSellerOrderTerms,
  orchestrationStatus,
  relayViaApp,
  resolveAgentKeys,
  resolveRolePolicies,
  seedCatalog,
  type MissionRunner,
  type OracleModel,
  type OrderTermsPort,
} from "./orchestration/index.js";
import { createSweepReconciler, MemoryExceptions, MemoryLedger, MemoryPurchaseIndex } from "./reconciliation/sweeps";
import { createSellerApp, resolveSellerConfig, sellersStatus } from "./sellers/index.js";
import { viemRecourseChain, viemRecourseReads } from "./sellers/recourse/chain.js";
import { resolveRecourseConfig } from "./sellers/recourse/config.js";
import { loadRecourseCatalog } from "./sellers/recourse/datasets.js";
import { createRecourseSellers } from "./sellers/recourse/index.js";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

/**
 * One process, three listeners' worth of modules:
 *   - the facilitator HTTP app (settle/reserve/release/delegate) with the ONLY relayer broadcaster;
 *   - the REST API + SSE activity feed over the database, fed by the read-only chain indexer and the ledger;
 *   - the SIMULATED sellers on their own port, settling through the facilitator in-process.
 * Boot fails loudly before anything is served: chain id, USDC domain, deployments file, treasury code and wiring.
 */
async function main(): Promise<void> {
  loadEnv();
  const config = readConfig();
  const deployments = await loadDeployments(config.deploymentsPath);

  // Signer: a Foundry keystore decrypted in memory (RELAYER_ACCOUNT + RELAYER_PASSWORD_FILE) or a dev key. Never logged.
  const signer = resolveSigner({ ...config.relayer, label: "RELAYER" });
  const account = signer.account;
  const client = viemChainClient(config.rpcUrl, account);

  const boot = await verifyBoot(client, deployments);
  log(`[boot] chain ${boot.chainId}, USDC ${boot.token.address} "${boot.token.name}" v${boot.token.version} separator ${boot.token.domainSeparator}`);
  log(`[boot] treasury ${boot.treasury}, escrowFactory ${boot.escrowFactory ?? "none"}, head block ${boot.blockNumber}`);
  const ethWei = await client.getBalance(account.address);
  log(`[boot] relayer ${account.address} (${signer.source}) holds ${ethWei} wei for gas (relayer never holds USDC)`);
  if (ethWei === 0n) log("[boot] WARNING: relayer has no ETH; every relay will fail");
  if (config.demoMode) log("[boot] DEMO_MODE=true: /demo/bypass and forceBroadcast enabled (x-demo-token required); SIMULATED flows are labeled");

  // Database: DATABASE_URL selects Postgres; otherwise PGlite at PGLITE_DATA_DIR (or in-memory). Migrate, then seed
  // the SIMULATED demo company and its agents (idempotent), then the SIMULATED seller catalog into `resources`.
  const database = await createDatabase({ log: console.log });
  await database.migrate();
  log(`[database] migrations applied (dialect=${database.dialect}, from ${database.migrationsFolder})`);
  const seeded = await seed(database.db);
  log(`[seed] organization "${seeded.organization.name}" (SIMULATED) agents=${seeded.agents.length}`);
  const catalog = await seedCatalog(database.db);
  log(`[catalog] SIMULATED catalog: ${catalog.total} listings (${catalog.inserted} inserted, ${catalog.existing} existing) from ${catalog.catalogPath}`);

  // Oracle extraction model: only with ANTHROPIC_API_KEY and CLAUDE_MODEL; otherwise plan answers 503.
  let oracle: OracleModel | null = null;
  if (process.env["ANTHROPIC_API_KEY"] && process.env["CLAUDE_MODEL"]?.trim()) {
    oracle = { client: new Anthropic(), model: oracleModelFromEnv() };
    log(`[oracle] extraction model ${oracle.model}`);
  } else {
    log("[oracle] idle: ANTHROPIC_API_KEY / CLAUDE_MODEL not set; POST /api/missions/:id/plan answers 503");
  }

  // Facilitator: the one relayer, the treasury log poller and the settle/reserve/release routes.
  const facilitatorBus = createBus();
  const poller = createLogPoller({ client, treasury: boot.treasury, bus: facilitatorBus, fromBlock: boot.blockNumber, intervalMs: config.eventsPollMs, log });
  const facilitatorApp = createFacilitatorApp({
    client,
    relayer: createRelayer({ client, address: account.address, log }),
    store: new MemoryStore(),
    bus: facilitatorBus,
    deployments,
    treasury: boot.treasury,
    usdc: deployments.usdc,
    demoMode: config.demoMode,
    ...(config.demoToken ? { demoToken: config.demoToken } : {}),
    now: () => new Date(),
    log,
  });

  // Chain indexer + ledger reconciliation: read-only, over the activity bus the API streams.
  const activityBus = createActivityBus();
  const indexerConfig = await resolveIndexerConfig();
  let indexer: Indexer | undefined;
  let reconciliation: Reconciliation | undefined;
  let treasuryRead: (() => ReturnType<typeof readTreasurySnapshot>) | undefined;
  let chainStatus: string;
  let ledgerStatus: string;
  if (indexerConfig.ok) {
    const ic = indexerConfig.config;
    const source = createLogSource(ic.rpcUrl);
    await source.assertChain();
    const materiality = process.env["RECONCILIATION_MATERIALITY_ATOMIC"];
    const recon = createReconciliation({
      db: database.db,
      reader: source,
      treasury: ic.treasury,
      usdc: ic.usdc,
      bus: activityBus,
      ...(materiality ? { materialityAtomic: BigInt(materiality) } : {}),
    });
    reconciliation = recon;
    treasuryRead = () => readTreasurySnapshot(source, { treasury: ic.treasury, usdc: ic.usdc });
    indexer = createIndexer({
      db: database.db,
      source,
      config: ic,
      bus: activityBus,
      afterTick: async (r) => {
        if (r.logsInserted > 0) await recon.run("indexer", r.toBlock);
      },
    });
    chainStatus = `indexing treasury ${ic.treasury} from block ${ic.deployBlock}`;
    ledgerStatus = `journal posted from chain events; reconciliation after every poll with new logs (materiality ${materiality ?? "10000"} atomic)`;
  } else {
    chainStatus = `idle: ${indexerConfig.reason}`;
    ledgerStatus = `idle: ${indexerConfig.reason}`;
    log(`[chain] indexer idle: ${indexerConfig.reason}`);
  }

  // SIMULATED sellers on their own port (SELLER_URL). They settle through the facilitator app in-process, so the
  // relayer key has one nonce manager. The attacker payee is never allowlisted.
  const sellerConfig = resolveSellerConfig();
  const facilitator = facilitatorViaApp(facilitatorApp, { demoToken: config.demoToken, log });

  // RECOURSE WIRING: the SIMULATED Recourse sellers (per-order escrow, reveal, challenge) and the buyer-side
  // OrderTermsPort that verifies their POST /orders answer against the factory. Needs the escrow factory from
  // deployments and SELLER_KEYS; each seller key holds gas ETH and bond USDC only, nothing of the treasury's.
  // One ChainClient + relayer per distinct seller address, so every key has exactly one nonce manager.
  const recourseConfig = resolveRecourseConfig();
  let recourse: ReturnType<typeof createRecourseSellers> | undefined;
  let orderTerms: OrderTermsPort | undefined;
  let recourseStatus: string;
  if (!boot.escrowFactory) recourseStatus = "idle: no escrowFactory in deployments";
  else if (!recourseConfig.ok) recourseStatus = `idle: ${recourseConfig.reason}`;
  else {
    const factory = boot.escrowFactory;
    const catalog = await loadRecourseCatalog();
    const chains = new Map<string, ReturnType<typeof viemRecourseChain>>();
    for (const key of recourseConfig.config.sellers.values()) {
      const addr = key.account.address.toLowerCase();
      if (chains.has(addr)) continue;
      const sellerClient = viemChainClient(config.rpcUrl, key.account);
      const relayer = createRelayer({ client: sellerClient, address: key.account.address, log });
      chains.set(addr, viemRecourseChain({ client: sellerClient, relayer, factory, usdc: deployments.usdc }));
    }
    const chainFor = (seller: Address) => {
      const chain = chains.get(seller.toLowerCase());
      if (!chain) throw new Error(`no chain client for seller ${seller}; SELLER_KEYS does not hold its key`);
      return chain;
    };
    recourse = createRecourseSellers({
      config: recourseConfig.config,
      listings: catalog.listings,
      chainFor,
      facilitator,
      sellerUrl: sellerConfig.sellerUrl,
      allowForceBroadcast: sellerConfig.allowForceBroadcast,
      intervalMs: config.eventsPollMs,
      log,
    });
    recourseStatus = recourse.status();
    for (const [addr] of chains) {
      const [eth, usdc] = await Promise.all([
        client.getBalance(addr as Address),
        client.readContract({ address: deployments.usdc, abi: erc20Abi, functionName: "balanceOf", args: [addr] }) as Promise<bigint>,
      ]);
      log(`[sellers:recourse:SIMULATED] seller key ${addr} holds ${eth} wei gas, ${formatUsdc(usdc)} USDC for bonds (never treasury funds)`);
      if (eth === 0n) log(`[sellers:recourse:SIMULATED] WARNING: seller ${addr} has no ETH; create/reveal/finalize will fail`);
    }
  }
  log(`[sellers:recourse:SIMULATED] ${recourseStatus}`);

  const sellerApp = createSellerApp({
    config: sellerConfig,
    facilitator,
    ...(recourse ? { recourse } : {}),
  });
  if (recourse && boot.escrowFactory) {
    // Buyer side: propose() asks the seller app in-process for an order and verifies it against the factory.
    orderTerms = createSellerOrderTerms({
      sellerUrl: sellerConfig.sellerUrl,
      fetch: (url, init) => Promise.resolve(sellerApp.request(url, init)),
      reads: viemRecourseReads(client, boot.escrowFactory, deployments.usdc),
      treasury: boot.treasury,
      log,
    });
  }
  // END RECOURSE WIRING

  // Mission runner: the orchestrator (AGENT_ROOT_KEY) signs CreateChild/PauseChild for the three sub-agents
  // (AGENT_KEYS) and relays them through the facilitator app in-process. Agents never send transactions.
  let runner: MissionRunner | undefined;
  let runnerStatus: string;
  const agentKeys = resolveAgentKeys();
  if (!agentKeys.ok) runnerStatus = `idle: ${agentKeys.reason}`;
  else if (!oracle) runnerStatus = "idle: CLAUDE_MODEL / ANTHROPIC_API_KEY unset";
  else {
    const policies = resolveRolePolicies(sellerConfig.payees, process.env, sellerConfig.attacker);
    runner = createMissionRunner({
      db: database.db,
      bus: activityBus,
      model: { client: oracle.client as Parameters<typeof createMissionRunner>[0]["model"]["client"], model: oracle.model },
      treasury: boot.treasury,
      chain: client,
      relay: relayViaApp(facilitatorApp),
      keys: agentKeys.keys,
      policies,
      sellerUrl: sellerConfig.sellerUrl,
      demoMode: config.demoMode,
      log,
    });
    runnerStatus = `live: orchestrator ${agentKeys.keys.root.address} (${agentKeys.keys.rootSource}); sub-agents research ${agentKeys.keys.children.research.address}, finance ${agentKeys.keys.children.finance.address}, verification ${agentKeys.keys.children.verification.address}; ${AGENT_KEYS_LIMITATION}`;
  }
  log(`[orchestration] mission runner ${runnerStatus}`);

  const { app } = createApp({
    db: database.db,
    bus: activityBus,
    ...(reconciliation && treasuryRead
      ? { ports: { reconciliation: { run: (trigger) => reconciliation!.run(trigger) }, treasury: { read: treasuryRead } } }
      : {}),
    treasury: boot.treasury,
    oracle,
    ...(runner ? { runner } : {}),
    ...(orderTerms ? { orderTerms } : {}),
    indexerStatus: () => indexer?.status() ?? { state: "idle", reason: indexerConfig.ok ? "not started" : indexerConfig.reason },
    status: {
      treasury: boot.treasury,
      escrowFactory: boot.escrowFactory,
      database: { dialect: database.dialect, migrationsFolder: database.migrationsFolder, migrated: true },
      modules: {
        api: "ready",
        orchestration: `${orchestrationStatus({ model: oracle?.model ?? null, treasury: boot.treasury, orderTermsWired: orderTerms !== undefined })}; mission runner ${runnerStatus}`,
        facilitator: `live: relayer ${account.address} (${signer.source}); routes at / and /facilitator`,
        sellers: sellersStatus(sellerConfig, true, recourseStatus),
        chain: chainStatus,
        ledger: ledgerStatus,
        sweeps: boot.escrowFactory ? `reconciling late arrivals and sweeps for factory ${boot.escrowFactory}` : "disabled: no escrow factory in deployments",
        exceptions: `controller requests target treasury ${boot.treasury}; done only on indexed AllowSet/CapRaised/NodePaused`,
      },
      dependsOn: [SCHEMAS],
    },
  });
  // Facilitator routes at the root (/settle, /reserve, /release, /verify, /delegate, /health) for the adapters and
  // scripts, and again under /facilitator so its own SSE feed (/facilitator/events) does not shadow the API's /events.
  app.route("/", facilitatorApp);
  app.route("/facilitator", facilitatorApp);

  poller.start();
  if (boot.escrowFactory) {
    // Books late arrivals into closed escrows and their sweep() recoveries; in-memory ledger until Postgres lands.
    createSweepReconciler({
      client,
      factory: boot.escrowFactory,
      usdc: deployments.usdc,
      treasury: boot.treasury,
      bus: facilitatorBus,
      purchases: new MemoryPurchaseIndex(),
      ledger: new MemoryLedger(),
      exceptions: new MemoryExceptions(),
      fromBlock: deployments.deployBlock ? BigInt(deployments.deployBlock) : boot.blockNumber,
      intervalMs: config.eventsPollMs * 2,
      log,
    }).start();
  }

  const server = serve({ fetch: app.fetch, port: config.port }, (info) =>
    log(`[service] chain ${CHAIN_ID} API + facilitator listening on http://localhost:${info.port}`),
  );
  const sellerServer = serve({ fetch: sellerApp.fetch, port: sellerConfig.port }, (info) => {
    log(`[sellers] SIMULATED sellers listening on http://localhost:${info.port} (${sellerConfig.sellerUrl})`);
    // RECOURSE WIRING: the sellers' worker (markFunded / revealKey / finalizePayout per behavior) starts once the app serves.
    recourse?.worker.start();
  });
  await indexer?.start();

  const shutdown = (): void => {
    poller.stop();
    recourse?.worker.stop();
    sellerServer.close();
    server.close(() => {
      void (indexer ? indexer.stop() : Promise.resolve())
        .then(() => database.close())
        .finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[service] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
