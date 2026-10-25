// Live acceptance script for the SIMULATED Recourse sellers (docs/SPEC.md "Recourse"), run against Base Sepolia:
//
//   1. honest: an order is created, the ciphertext verifies, a sample verifies, the treasury pays the escrow
//      through x402, the seller reveals the key, every chunk decrypts to its committed leaf, PaidOut lands;
//   2. ghost:  the seller never reveals; after revealDeadline the buyer calls claimTimeoutRefund and the
//      treasury gets the price (and the seller's bond) back;
//   3. swap:   the seller commits a ciphertext whose one chunk decrypts to something else; after the reveal the
//      buyer proves it with complainMismatch (tier 2), the escrow refunds and the factory flags the seller.
//
//   pnpm --filter @overflow/service recourse:demo [--resource <listingId>] [--swap-seller <sellerId>]
//        [--swap-resource <listingId>] [--reveal-window 180] [--challenge-window 60] [--skip-swap] [--skip-ghost]
//
// Env (repo .env): SELLER_URL (the service must be running with SELLER_KEYS set), BASE_SEPOLIA_RPC_URL, the
// relayer signer (buyer-side claimTimeoutRefund / complainMismatch), AGENT_ROOT_KEY (the paying node),
// deployments/base-sepolia.json with escrowFactory. Beats 1 and 2 use sim-seller-a's 4 USDC listing; beat 3
// uses sim-seller-b (its 13 USDC listing) so the flag lands on seller B and seller A stays buyable.
//
// This script never calls USDC to move funds, never retries a payment with a new nonce, and reports only what
// the chain confirmed. Nothing here is a real marketplace: every seller is SIMULATED.
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { parsePaymentResponse, wrapFetch, X402_HEADERS } from "@overflow/payment-client";
import { resolveSigner } from "@overflow/payment-client/keystore";
import {
  buildMismatchComplaint,
  buildTree,
  checkMismatch,
  DatasetManifestSchema,
  decryptChunk,
  getProof,
  hashLeaf,
  pickSampleIndices,
  splitDataset,
  verifyCiphertext,
  verifySample,
} from "@overflow/recourse-crypto";
import {
  computeOrderId,
  computeTermsHash,
  explorerUrl,
  loadDeployments,
  overflowEscrowAbi,
  overflowEscrowFactoryAbi,
  PurchaseOrderSchema,
  USDC,
  type Address,
  type Hex,
} from "@overflow/schemas";
import { encodeFunctionData, erc20Abi, toHex } from "viem";
import { viemChainClient, type ChainClient } from "../src/chain/client.js";
import { loadEnv, readConfig } from "../src/config.js";
import { createRelayer } from "../src/facilitator/relayer.js";
import { CreateOrderResponseSchema, SampleResponseSchema, type CreateOrderResponse, type SellerBehavior } from "../src/sellers/recourse/protocol.js";

const { values: args } = parseArgs({
  options: {
    resource: { type: "string", default: "listing-national-monthly-2021-2022" },
    "swap-seller": { type: "string", default: "sim-seller-b" },
    "swap-resource": { type: "string", default: "listing-national-monthly-2024-2026-seller-b" },
    "reveal-window": { type: "string", default: "180" },
    "challenge-window": { type: "string", default: "60" },
    "skip-swap": { type: "boolean", default: false },
    "skip-ghost": { type: "boolean", default: false },
  },
});

const log = (s: string): void => console.log(s);
let failures = 0;
function check(ok: boolean, what: string): void {
  log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
}
const fail = (what: string): never => {
  check(false, what);
  throw new Error(what);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STATUS = ["Created", "Funded", "Revealed", "Settled", "Refunded"] as const;
const usdc = (n: bigint) => `${(Number(n) / 1e6).toFixed(6)} USDC`;
const SAMPLE_SIZE = 20;

async function main(): Promise<void> {
  loadEnv();
  const config = readConfig();
  const d = await loadDeployments(config.deploymentsPath);
  if (!d.escrowFactory) fail("deployments file has no escrowFactory; run pnpm contracts:deploy");
  const factory = d.escrowFactory as Address;
  const sellerUrl = (process.env["SELLER_URL"] ?? "http://localhost:4100").replace(/\/$/, "");
  const revealWindowS = Number(args["reveal-window"]);
  const challengeWindowS = Number(args["challenge-window"]);

  // Buyer-side signer for contract calls (gas only): the relayer key, through the same relayer pattern the service uses.
  const relayerSigner = resolveSigner({ ...config.relayer, label: "RELAYER" });
  const client = viemChainClient(config.rpcUrl, relayerSigner.account);
  const relayer = createRelayer({ client, address: relayerSigner.account.address, log });
  // The paying node: the orchestrator's root key (node 1).
  const root = resolveSigner({
    keyOrAddress: process.env["AGENT_ROOT_KEY"],
    account: process.env["AGENT_ROOT_ACCOUNT"] ?? "overflow-agent-root",
    passwordFile: process.env["AGENT_ROOT_PASSWORD_FILE"],
    label: "AGENT_ROOT",
  });
  const treasury = d.treasury as Address;

  log(`recourse-demo: SIMULATED sellers at ${sellerUrl}, treasury ${treasury}, factory ${factory}`);
  log(`  buyer tx signer ${relayerSigner.account.address} (${relayerSigner.source}), paying node key ${root.account.address} (${root.source})`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (res: Response): Promise<any> => res.json() as Promise<any>;
  const health = await json(await fetch(`${sellerUrl}/health`));
  check(health?.simulated === true && health?.recourse, "seller /health is up and reports the recourse module");

  const read = <T,>(address: Address, abi: readonly unknown[], functionName: string, fnArgs: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args: fnArgs }) as Promise<T>;
  const balanceOf = (a: Address) => read<bigint>(d.usdc as Address, erc20Abi, "balanceOf", [a]);
  const statusOf = async (escrow: Address) => STATUS[Number(await read<bigint | number>(escrow, overflowEscrowAbi, "status"))]!;
  const blockNow = async () => BigInt(Math.floor(Date.now() / 1000));

  async function submit(to: Address, abi: readonly unknown[], functionName: string, fnArgs: readonly unknown[], label: string): Promise<Hex> {
    await client.simulateContract({ address: to, abi, functionName, args: fnArgs, account: relayerSigner.account.address });
    const data = encodeFunctionData({ abi, functionName, args: fnArgs } as unknown as Parameters<typeof encodeFunctionData>[0]);
    const r = await relayer.submit({ to, data, label });
    if (r.status !== "success") fail(`${label}: ${r.status} ${r.hash} ${"error" in r ? r.error : ""}`);
    log(`  ${label}: ${explorerUrl("tx", r.hash)}`);
    return r.hash;
  }

  async function waitFor(escrow: Address, want: (typeof STATUS)[number], timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const s = await statusOf(escrow);
      if (s === want) return true;
      if (STATUS.indexOf(s) > STATUS.indexOf(want) || s === "Refunded") return s === want;
      await sleep(4000);
    }
    return false;
  }

  async function setBehavior(sellerId: string, behavior: SellerBehavior): Promise<void> {
    const res = await fetch(`${sellerUrl}/sellers/${sellerId}/behavior`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ behavior }) });
    const body = await json(res);
    check(res.status === 200 && body.behavior === behavior && body.simulated === true, `PUT /sellers/${sellerId}/behavior -> ${behavior}`);
  }

  interface OpenedOrder {
    order: CreateOrderResponse;
    escrow: Address;
    cipherChunks: Uint8Array[];
    plainLeaves: Hex[];
    sampleCaught: number;
  }

  /** POST /orders, verify the terms as the service's OrderTermsPort does, fetch + verify cipher and manifest, sample. */
  async function openOrder(resourceId: string, missionId: string): Promise<OpenedOrder> {
    const res = await fetch(`${sellerUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceId, buyerTreasury: treasury, missionId, revealWindowS, challengeWindowS }),
    });
    const raw = await json(res);
    if (res.status !== 201 && res.status !== 200) fail(`POST /orders ${res.status}: ${JSON.stringify(raw)}`);
    const order = CreateOrderResponseSchema.parse(raw);
    const t = order.terms;
    log(`  order ${order.orderId} escrow ${order.escrowAddress} create ${explorerUrl("tx", order.createTxHash)}`);
    const termsHash = computeTermsHash({
      token: t.token, amountAtomic: t.amount, bondAtomic: t.bond, manifestHash: t.manifestHash, rootPlain: t.rootPlain, rootCipher: t.rootCipher,
      keyCommitment: t.keyCommitment, revealDeadline: t.revealDeadline, challengeWindow: t.challengeWindow, sourceKey: t.sourceKey, minTimestamp: t.minTimestamp,
      chunkCount: String(t.chunkCount),
    });
    check(termsHash === t.termsHash.toLowerCase(), "termsHash recomputes with computeTermsHash");
    const orderId = computeOrderId({ missionId, resourceId, buyer: treasury, seller: t.seller, amountAtomic: t.amount, termsHash: t.termsHash, salt: order.salt });
    check(orderId === order.orderId.toLowerCase() && orderId === t.orderId.toLowerCase(), "orderId recomputes with computeOrderId");
    check(t.buyer.toLowerCase() === treasury.toLowerCase() && t.token.toLowerCase() === USDC.address.toLowerCase(), "terms bind the treasury as buyer and USDC as token");
    const predicted = await read<Address>(factory, overflowEscrowFactoryAbi, "predict", [order.orderId, t.termsHash]);
    const isEscrow = await read<boolean>(factory, overflowEscrowFactoryAbi, "isEscrow", [order.escrowAddress]);
    check(predicted.toLowerCase() === order.escrowAddress.toLowerCase() && isEscrow, "factory.predict matches and isEscrow is true on chain");
    const escrow = order.escrowAddress as Address;
    const code = await client.getCode(escrow);
    check(!!code && code !== "0x", "escrow has code");

    const cipherRes = await fetch(order.cipherUrl);
    const cipherBytes = new Uint8Array(await cipherRes.arrayBuffer());
    const cipherChunks = splitDataset(cipherBytes);
    check(verifyCiphertext(cipherChunks, t.rootCipher, t.chunkCount), `ciphertext (${cipherChunks.length} chunks) Merkles to rootCipher`);

    const manifest = DatasetManifestSchema.parse(await (await fetch(`${sellerUrl}/r/${resourceId}/manifest`)).json());
    check(manifest.rootPlain.toLowerCase() === t.rootPlain.toLowerCase() && manifest.chunkCount === t.chunkCount, "manifest rootPlain/chunkCount equal the terms");
    const plainLeaves = manifest.plainLeaves as Hex[];
    const plainTree = buildTree(plainLeaves);
    const cipherTree = buildTree(cipherChunks.map(hashLeaf));

    const indices = pickSampleIndices(t.chunkCount, SAMPLE_SIZE, toHex(randomBytes(32)));
    const sampleRes = await fetch(order.sampleUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ indices }) });
    const sample = SampleResponseSchema.parse(await sampleRes.json());
    let sampleOk = 0;
    let sampleCaught = 0;
    for (const r of sample.reveals) {
      const v = verifySample(cipherChunks[r.index]!, r.chunkKey, plainLeaves[r.index]!, {
        index: r.index, cipherProof: getProof(cipherTree, r.index), plainProof: getProof(plainTree, r.index), rootCipher: t.rootCipher, rootPlain: t.rootPlain, chunkCount: t.chunkCount,
      });
      if (v.ok) sampleOk++;
      else if (v.reason === "decrypt-mismatch") sampleCaught++;
    }
    check(sample.reveals.length === indices.length && sampleOk + sampleCaught === indices.length, `sample of ${indices.length}: ${sampleOk} verified, ${sampleCaught} decrypt mismatches`);
    return { order, escrow, cipherChunks, plainLeaves, sampleCaught };
  }

  /** The agent pays GET /r/:id?order= through x402; checkQuote takes the escrow branch because payTo == order.escrowAddress. */
  async function pay(o: OpenedOrder, resourceId: string, missionId: string): Promise<Hex> {
    const t = o.order.terms;
    const now = Math.floor(Date.now() / 1000);
    const purchase = PurchaseOrderSchema.parse({
      id: `recourse-demo-${o.order.orderId.slice(2, 18)}`,
      orderIdBytes32: o.order.orderId,
      missionId,
      resourceId,
      buyerTreasury: treasury,
      sellerAddress: t.seller,
      escrowAddress: o.escrow,
      chainId: 84532,
      tokenAddress: USDC.address,
      amountAtomic: t.amount,
      payingNodeId: 1,
      participatingAgentIds: [],
      allocations: [],
      resourceManifestHash: t.manifestHash,
      termsHash: t.termsHash,
      paymentPath: "overflow-facilitator",
      txHashes: [],
      createdAt: new Date(now * 1000).toISOString(),
      authorizationExpiresAt: new Date(Math.min(Number(t.revealDeadline), now + 120) * 1000).toISOString(),
      status: "RESERVED",
    });
    const paidFetch = wrapFetch(fetch, { nodeAccount: root.account, treasury, adapter: { resolveOrder: async () => purchase } });
    const res = await paidFetch(o.order.resourceUrl);
    const body = await json(res);
    if (res.status !== 200) fail(`paid GET /r/${resourceId}?order= answered ${res.status}: ${JSON.stringify(body)}`);
    const settlement = parsePaymentResponse(res);
    check(!!settlement?.transaction && body.simulated === true && body.escrowAddress.toLowerCase() === o.escrow.toLowerCase(), `paid: ${X402_HEADERS.paymentResponse} carries the settle tx`);
    const txHash = settlement!.transaction as Hex;
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeoutMs: 120_000 });
    check(receipt.status === "success", `settle() receipt success ${explorerUrl("tx", txHash)}`);
    return txHash;
  }

  async function revealedKey(escrow: Address): Promise<Hex> {
    return read<Hex>(escrow, overflowEscrowAbi, "revealedKey");
  }

  function mismatches(o: OpenedOrder, key: Hex): number[] {
    const out: number[] = [];
    o.cipherChunks.forEach((c, i) => {
      if (checkMismatch(i, c, key, o.plainLeaves[i]!).mismatch) out.push(i);
    });
    return out;
  }

  // ---- beat 1: honest -----------------------------------------------------------------------------------------
  const honestResource = args.resource!;
  const honestMission = `recourse-demo-honest-${Date.now()}`;
  log("\n1. honest seller (sim-seller-a): order, verify, sample, pay, reveal, decrypt, PaidOut");
  await setBehavior("sim-seller-a", "honest");
  const treasuryBefore = await balanceOf(treasury);
  const honest = await openOrder(honestResource, honestMission);
  const sellerA = honest.order.terms.seller as Address;
  const sellerABefore = await balanceOf(sellerA);
  await pay(honest, honestResource, honestMission);
  check(await waitFor(honest.escrow, "Funded", 180_000), "escrow reached Funded (seller worker called markFunded)");
  check(await waitFor(honest.escrow, "Revealed", 180_000), "escrow reached Revealed (seller revealed the key)");
  const kHonest = await revealedKey(honest.escrow);
  const badHonest = mismatches(honest, kHonest);
  check(badHonest.length === 0, `revealed key decrypts all ${honest.cipherChunks.length} chunks to the committed leaves`);
  check(hashLeaf(decryptChunk(honest.cipherChunks[0]!, kHonest, 0)) === honest.plainLeaves[0]!.toLowerCase(), "chunk 0 decrypts to plainLeaves[0]");
  check(await waitFor(honest.escrow, "Settled", (challengeWindowS + 150) * 1000), "escrow reached Settled after the challenge window (finalizePayout)");
  const sellerAAfter = await balanceOf(sellerA);
  const amountHonest = BigInt(honest.order.terms.amount);
  const bondHonest = BigInt(honest.order.terms.bond);
  check(sellerAAfter - sellerABefore === amountHonest, `seller A received the price: +${usdc(sellerAAfter - sellerABefore)} (bond ${usdc(bondHonest)} returned)`);
  check((await balanceOf(honest.escrow)) === 0n, "escrow holds 0 USDC after payout");
  log(`  treasury ${usdc(treasuryBefore)} -> ${usdc(await balanceOf(treasury))}`);

  // ---- beat 2: ghost ------------------------------------------------------------------------------------------
  if (!args["skip-ghost"]) {
    log("\n2. ghost seller (sim-seller-a switched to ghost): pay, no reveal, claimTimeoutRefund after the deadline");
    await setBehavior("sim-seller-a", "ghost");
    const ghostMission = `recourse-demo-ghost-${Date.now()}`;
    const tBefore = await balanceOf(treasury);
    const ghost = await openOrder(honestResource, ghostMission);
    await pay(ghost, honestResource, ghostMission);
    check(await waitFor(ghost.escrow, "Funded", 180_000), "escrow reached Funded");
    const deadline = BigInt(ghost.order.terms.revealDeadline);
    while ((await blockNow()) <= deadline + 5n) await sleep(5000);
    check((await statusOf(ghost.escrow)) === "Funded", "still Funded after revealDeadline: the ghost never revealed");
    await submit(ghost.escrow, overflowEscrowAbi, "claimTimeoutRefund", [], "claimTimeoutRefund");
    check((await statusOf(ghost.escrow)) === "Refunded", "escrow is Refunded");
    const tAfter = await balanceOf(treasury);
    check(tAfter - tBefore === BigInt(ghost.order.terms.bond), `treasury restored and received the seller bond: net ${usdc(tAfter - tBefore)}`);
    await setBehavior("sim-seller-a", "honest");
  }

  // ---- beat 3: swap -------------------------------------------------------------------------------------------
  if (!args["skip-swap"]) {
    const swapSeller = args["swap-seller"]!;
    const swapResource = args["swap-resource"]!;
    log(`\n3. swap seller (${swapSeller}): one tampered chunk; after the reveal the buyer proves it with complainMismatch`);
    await setBehavior(swapSeller, "swap");
    const swapMission = `recourse-demo-swap-${Date.now()}`;
    const tBefore = await balanceOf(treasury);
    const swap = await openOrder(swapResource, swapMission);
    const sellerB = swap.order.terms.seller as Address;
    const cheatsBefore = await read<bigint>(factory, overflowEscrowFactoryAbi, "provenCheats", [sellerB]);
    check(cheatsBefore === 0n, "swap seller not flagged before the proof");
    log(`  sample caught the swap: ${swap.sampleCaught > 0 ? "yes (a real buyer stops here; the demo pays to exercise the proof)" : `no (expected: p = ${SAMPLE_SIZE}/${swap.order.terms.chunkCount})`}`);
    await pay(swap, swapResource, swapMission);
    check(await waitFor(swap.escrow, "Funded", 180_000), "escrow reached Funded");
    check(await waitFor(swap.escrow, "Revealed", 180_000), "escrow reached Revealed (swap seller reveals the true key)");
    const kSwap = await revealedKey(swap.escrow);
    const bad = mismatches(swap, kSwap);
    check(bad.length === 1, `exactly one chunk mismatches rootPlain after decryption: ${JSON.stringify(bad)}`);
    const complaint = buildMismatchComplaint({ index: bad[0]!, cipherChunks: swap.cipherChunks, plainLeaves: swap.plainLeaves, revealedKey: kSwap, rootCipher: swap.order.terms.rootCipher, rootPlain: swap.order.terms.rootPlain });
    await submit(swap.escrow, overflowEscrowAbi, "complainMismatch", [complaint.i, complaint.cipherChunk, complaint.cipherProof, complaint.plainLeaf, complaint.plainProof], "complainMismatch");
    check((await statusOf(swap.escrow)) === "Refunded", "escrow is Refunded (mismatch)");
    const cheatsAfter = await read<bigint>(factory, overflowEscrowFactoryAbi, "provenCheats", [sellerB]);
    check(cheatsAfter === 1n, `factory.provenCheats(seller) == ${cheatsAfter}`);
    const tAfter = await balanceOf(treasury);
    check(tAfter - tBefore === BigInt(swap.order.terms.bond), `treasury refunded plus the bond: net ${usdc(tAfter - tBefore)}`);
    const again = await fetch(`${sellerUrl}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceId: swapResource, buyerTreasury: treasury, missionId: `${swapMission}-again` }) });
    check(again.status === 409, `a new order from the flagged seller is refused (${again.status})`);
    await setBehavior(swapSeller, "honest");
  }

  log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`recourse-demo: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
