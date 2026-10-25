import { createRepositories, type Db } from "@overflow/database";
import { buildPaymentPayload, signTransfer } from "@overflow/payment-client";
import { decryptDataset, hashLeaf, verifyCiphertext } from "@overflow/recourse-crypto";
import {
  computeOrderId,
  computeTermsHash,
  overflowEscrowAbi,
  overflowEscrowFactoryAbi,
  type ActivityEvent,
  type Address,
  type Hex,
  type PurchaseStatus,
} from "@overflow/schemas";
import { concatHex, ContractFunctionRevertedError, createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, stringToHex, type Abi } from "viem";
import { generatePrivateKey, type PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { ActivityBus } from "../chain/bus.js";
import type { ChainClient } from "../chain/client.js";
import type { Relayer } from "../facilitator/relayer.js";
import type { Facilitator } from "../facilitator/settle.js";
import { createPurchaseService } from "../orchestration/purchase-service.js";
import { requirementFor } from "../sellers/paywall.js";
import type { RecourseAccounts } from "./accounts.js";
import { assertAnvil, chainNow, increaseTime, mine } from "./anvil.js";
import { loadListingDataset, type LoadedDataset } from "./dataset.js";
import { buildMismatchEvidence, drawSample, findFirstMismatch, judgeSample, SAMPLE_RANDOMNESS_LABEL, verifySampleRows } from "./evidence.js";
import { createSimSeller, sampleFor, type SellerBehaviour, type SellerOrder, type SimSeller } from "./seller-sim.js";

// ---------------------------------------------------------------------------
// The P5.2 minimum, end to end on a local Anvil fork of Base Sepolia: three
// SIMULATED orders (honest, ghost, swap) through the real contracts, the real
// facilitator settle() path and the real indexer. Agents propose; only
// contracts move money: the price leaves the treasury through settle(), the
// bond comes from the seller, and every status the UI shows comes from the
// indexer's confirmed events, never from this runner. The runner records the
// buyer's evidence (sample, complaint) and sends the calls the SPEC assigns to
// the buyer side (create, markFunded, accept, complainMismatch,
// claimTimeoutRefund) through the one relayer. Refuses on anything but Anvil.
// ---------------------------------------------------------------------------

export const RECOURSE_MISSION_ID = "mission-recourse-anvil";
const SAMPLE_COUNT = 3;
const CHALLENGE_WINDOW = 600n;
/** Seconds the ghost's reveal window is shorter than the warp below, so the timeout refund is claimable after one warp. */
const REVEAL_WINDOW: Record<SellerBehaviour, bigint> = { honest: 1200n, ghost: 900n, swap: 1200n };
const WARP_SECONDS = 1800;
const ORDERS: ReadonlyArray<{ behaviour: SellerBehaviour; listingId: string; bondAtomic: bigint }> = [
  { behaviour: "honest", listingId: "listing-national-monthly-2024-2026", bondAtomic: 2_400_000n },
  { behaviour: "ghost", listingId: "listing-california-monthly-2024-2026", bondAtomic: 1_000_000n },
  { behaviour: "swap", listingId: "listing-national-monthly-2024-2026-seller-b", bondAtomic: 2_600_000n },
];

const usdcAbi = parseAbi(["function transfer(address to, uint256 value) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

export interface RecourseRunDeps {
  db: Db;
  bus: ActivityBus;
  rpcUrl: string;
  treasury: Address;
  escrowFactory: Address;
  usdc: Address;
  chain: ChainClient;
  relayer: Relayer;
  facilitator: Facilitator;
  accounts: RecourseAccounts;
  catalogPath?: string | undefined;
  log: (line: string) => void;
}

export interface OrderOutcome {
  behaviour: SellerBehaviour;
  listingId: string;
  purchaseId: string;
  escrow: Address;
  orderId: Hex;
  seller: Address;
  amountAtomic: string;
  bondAtomic: string;
  sampleVerdict: "buy" | "skip";
  /** What the runner did last for this order; the chain and the indexer decide the status. */
  lastStep: string;
  txs: Record<string, Hex>;
}

export interface RecourseRunResult {
  orders: OrderOutcome[];
  warpedSeconds: number;
}

interface LiveOrder {
  spec: (typeof ORDERS)[number];
  seller: SimSeller;
  dataset: LoadedDataset;
  salt: Hex;
  k: Hex;
  order: SellerOrder;
  orderId: Hex;
  termsHash: Hex;
  escrow: Address;
  purchaseId: string;
  amount: bigint;
  revealDeadline: bigint;
  outcome: OrderOutcome;
}

const SOURCE = { kind: "adapter", reference: "recourse-anvil-runner" } as const;
const isRevert = (e: unknown): string | undefined => {
  const r = e instanceof Error && "walk" in e ? (e as { walk: (f: (x: unknown) => boolean) => unknown }).walk((x) => x instanceof ContractFunctionRevertedError) : undefined;
  if (r instanceof ContractFunctionRevertedError) return r.data ? `${r.data.errorName}(${(r.data.args ?? []).map(String).join(",")})` : r.shortMessage;
  return undefined;
};

export async function runRecourseOnAnvil(deps: RecourseRunDeps): Promise<RecourseRunResult> {
  const { log, rpcUrl } = deps;
  await assertAnvil(rpcUrl);
  const chainId = await deps.chain.getChainId();
  if (chainId !== 84532) throw new Error(`refused: Anvil reports chain ${chainId}, expected a Base Sepolia fork (84532)`);
  const tag = "[recourse:SIMULATED]";
  const repos = createRepositories(deps.db);
  const purchases = createPurchaseService(deps.db, { publish: (e) => deps.bus.publish(e) });
  const pub = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  const note = async (kind: ActivityEvent["kind"], message: string, purchaseId: string, txHash?: Hex): Promise<void> => {
    const event = await repos.activityEvents.insert({ kind, message, purchaseId, missionId: RECOURSE_MISSION_ID, ...(txHash ? { txHash } : {}), simulated: true });
    deps.bus.publish(event);
  };

  /** Simulate with the relayer account, then send through the one relayer; a revert is decoded and thrown, never retried. */
  const relay = async (label: string, to: Address, abi: Abi | readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> => {
    try {
      await deps.chain.simulateContract({ address: to, abi, functionName, args, account: deps.relayer.address });
    } catch (e) {
      throw new Error(`${label}: simulation reverted ${isRevert(e) ?? (e instanceof Error ? e.message : String(e))}`);
    }
    const r = await deps.relayer.submit({ to, data: encodeFunctionData({ abi, functionName, args } as never), label });
    if (r.status !== "success") throw new Error(`${label}: ${r.status} ${r.hash}${r.status === "unknown" ? ` (${r.error})` : ""}`);
    log(`${tag} ${label} confirmed ${r.hash} block ${r.receipt.blockNumber}`);
    return r.hash;
  };

  /** A SIMULATED seller's own transaction (bond transfer, revealKey): the seller's key, not the relayer's. */
  const sellerSend = async (seller: SimSeller, label: string, to: Address, abi: Abi | readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> => {
    const wallet = createWalletClient({ account: seller.account, chain: baseSepolia, transport: http(rpcUrl) });
    try {
      await pub.simulateContract({ address: to, abi, functionName, args, account: seller.account } as never);
    } catch (e) {
      throw new Error(`${label}: simulation reverted ${isRevert(e) ?? (e instanceof Error ? e.message : String(e))}`);
    }
    const hash = await wallet.writeContract({ address: to, abi, functionName, args } as never);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`${label}: reverted ${hash}`);
    log(`${tag} ${label} (seller ${seller.address}) confirmed ${hash} block ${receipt.blockNumber}`);
    return hash;
  };

  if (!(await repos.missions.getById(RECOURSE_MISSION_ID))) {
    await repos.missions.insert({
      id: RECOURSE_MISSION_ID,
      organizationId: "org-demo",
      goal: "SIMULATED recourse demo on local Anvil: buy EV registration datasets from an honest, a ghost and a swap seller",
      budgetAtomic: "100000000",
      rootNodeId: 1,
      status: "active",
    });
  }

  const sellers: Record<SellerBehaviour, PrivateKeyAccount> = deps.accounts.sellers;
  const live: LiveOrder[] = [];

  // ---- Phase A: every order is created, sampled, funded and marked funded before any clock warp ------------------
  for (const spec of ORDERS) {
    const dataset = await loadListingDataset(spec.listingId, deps.catalogPath);
    const resource = await repos.resources.getById(spec.listingId);
    if (!resource) throw new Error(`resource ${spec.listingId} is not seeded (seedCatalog runs at boot)`);
    const seller = createSimSeller({ behaviour: spec.behaviour, account: sellers[spec.behaviour], dataset, secret: keccak256(stringToHex(`SIMULATED seller secret ${spec.behaviour}`)) });
    const salt = generatePrivateKey(); // 32 random bytes; feeds orderId and the per-order key
    const sampleRandomness = keccak256(concatHex([salt, stringToHex(SAMPLE_RANDOMNESS_LABEL)]));
    const amount = BigInt(dataset.listing.priceAtomic);
    const now = await chainNow(rpcUrl);
    const revealDeadline = now + REVEAL_WINDOW[spec.behaviour];

    // Seller commits; buyer derives the terms, the order id and the escrow address the factory will use.
    const order = seller.createOrder({ salt, buyer: deps.treasury, sampleCount: SAMPLE_COUNT, sampleRandomness });
    const k = seller.keyFor({ salt, buyer: deps.treasury });
    const termsInput = {
      token: deps.usdc,
      amountAtomic: amount.toString(),
      bondAtomic: spec.bondAtomic.toString(),
      manifestHash: dataset.manifest.manifestHash,
      rootPlain: order.rootPlain,
      rootCipher: order.rootCipher,
      keyCommitment: order.keyCommitment,
      revealDeadline: revealDeadline.toString(),
      challengeWindow: CHALLENGE_WINDOW.toString(),
      sourceKey: dataset.manifest.sourceKey,
      minTimestamp: dataset.manifest.minTimestamp,
      chunkCount: order.chunkCount.toString(),
    };
    const termsHash = computeTermsHash(termsInput);
    const orderId = computeOrderId({ missionId: RECOURSE_MISSION_ID, resourceId: spec.listingId, buyer: deps.treasury, seller: seller.address, amountAtomic: amount.toString(), termsHash, salt });
    const escrow = (await deps.chain.readContract({ address: deps.escrowFactory, abi: overflowEscrowFactoryAbi, functionName: "predict", args: [orderId, termsHash] })) as Address;
    log(`${tag} ${spec.behaviour}: ${seller.label}; listing ${spec.listingId} ${amount} atomic USDC, bond ${spec.bondAtomic}, ${order.chunkCount} chunks, escrow ${escrow}`);

    // Buyer checks before paying: the ciphertext Merkles to rootCipher; sample 3 chunks; verify; judge.
    if (!verifyCiphertext(order.cipherChunks, order.rootCipher, order.chunkCount)) throw new Error(`${spec.behaviour}: served ciphertext does not Merkle to rootCipher`);
    const indices = drawSample(SAMPLE_COUNT, order.chunkCount, sampleRandomness);
    const served = sampleFor(seller, order, k, indices);
    const rows = verifySampleRows({ cipherChunks: order.cipherChunks, plainLeaves: dataset.plainLeaves, rootCipher: order.rootCipher, rootPlain: order.rootPlain, chunkCount: order.chunkCount, revealed: served.revealed });
    const judgment = await judgeSample({ rows, header: dataset.manifest.header, sourceKey: dataset.manifest.sourceKey, minTimestamp: BigInt(dataset.manifest.minTimestamp) });

    // Records first, so the indexer can match every chain event to this purchase.
    const proposed = await purchases.propose({
      purchase: {
        idempotencyKey: `${RECOURSE_MISSION_ID}:${spec.listingId}:${salt}`,
        orderIdBytes32: orderId,
        missionId: RECOURSE_MISSION_ID,
        resourceId: spec.listingId,
        buyerTreasury: deps.treasury,
        sellerAddress: seller.address,
        escrowAddress: escrow,
        chainId: 84532,
        tokenAddress: deps.usdc,
        amountAtomic: amount.toString(),
        payingNodeId: 1,
        participatingAgentIds: ["agent-research"],
        allocations: [{ agentId: "agent-research", department: "research", amountAtomic: amount.toString() }],
        resourceManifestHash: dataset.manifest.manifestHash,
        termsHash,
        paymentPath: "overflow-facilitator",
        authorizationExpiresAt: new Date(Number(now + 600n) * 1000).toISOString(),
      },
      reason: `${seller.label}: recourse demo order (${spec.behaviour})`,
      source: SOURCE,
      simulated: true,
    });
    const purchaseId = proposed.purchase.id;
    await repos.escrowOrders.insert({
      purchaseId,
      orderIdBytes32: orderId,
      escrowAddress: escrow,
      sellerAddress: seller.address,
      amountAtomic: amount.toString(),
      bondAtomic: spec.bondAtomic.toString(),
      termsHash,
      manifestHash: dataset.manifest.manifestHash,
      rootPlain: order.rootPlain,
      rootCipher: order.rootCipher,
      keyCommitment: order.keyCommitment,
      revealDeadline: revealDeadline.toString(),
      challengeWindow: CHALLENGE_WINDOW.toString(),
      sourceKey: dataset.manifest.sourceKey,
      minTimestamp: dataset.manifest.minTimestamp,
      chunkCount: order.chunkCount,
    });
    await repos.samples.insert({ purchaseId, indices, randomness: sampleRandomness, verdict: judgment.verdict, reason: judgment.reason, judge: judgment.judge, rows, simulated: true });
    await note("sample.judged", `sample [${indices.join(", ")}] judged ${judgment.verdict} by ${judgment.judge}: ${judgment.reason}`, purchaseId);
    log(`${tag} ${spec.behaviour}: sample [${indices.join(", ")}] -> ${judgment.verdict} (${judgment.judge})`);

    const outcome: OrderOutcome = {
      behaviour: spec.behaviour,
      listingId: spec.listingId,
      purchaseId,
      escrow,
      orderId,
      seller: seller.address,
      amountAtomic: amount.toString(),
      bondAtomic: spec.bondAtomic.toString(),
      sampleVerdict: judgment.verdict,
      lastStep: "sampled",
      txs: {},
    };
    const item: LiveOrder = { spec, seller, dataset, salt, k, order, orderId, termsHash, escrow, purchaseId, amount, revealDeadline, outcome };
    live.push(item);
    if (judgment.verdict !== "buy") {
      log(`${tag} ${spec.behaviour}: sample judged skip; no order created, nothing paid`);
      continue;
    }

    // Chain: the factory opens the order at the predicted address; the seller posts its bond.
    outcome.txs["create"] = await relay(`factory.create(${spec.behaviour})`, deps.escrowFactory, overflowEscrowFactoryAbi, "create", [
      { orderId, buyer: deps.treasury, seller: seller.address, token: deps.usdc, amount, bond: spec.bondAtomic, termsHash, manifestHash: dataset.manifest.manifestHash, rootPlain: order.rootPlain, rootCipher: order.rootCipher, keyCommitment: order.keyCommitment, revealDeadline, challengeWindow: CHALLENGE_WINDOW, sourceKey: dataset.manifest.sourceKey, minTimestamp: BigInt(dataset.manifest.minTimestamp), chunkCount: order.chunkCount },
    ]);
    if (!(await deps.chain.readContract({ address: deps.escrowFactory, abi: overflowEscrowFactoryAbi, functionName: "isEscrow", args: [escrow] }))) throw new Error(`${spec.behaviour}: factory did not create ${escrow}`);
    outcome.txs["bond"] = await sellerSend(seller, `usdc.transfer(bond ${spec.bondAtomic})`, deps.usdc, usdcAbi, "transfer", [escrow, spec.bondAtomic]);

    // Payment: the root node key signs an EIP-3009 authorization for the price only; the facilitator settles it.
    const signed = await signTransfer({ nodeAccount: deps.accounts.rootNode, treasury: deps.treasury, to: escrow, value: amount, ttlSeconds: 600, nowSeconds: Number(await chainNow(rpcUrl)) });
    await purchases.transition(purchaseId, "RESERVED", { reason: `root node ${deps.accounts.rootNode.address} signed TransferWithAuthorization for ${amount} atomic USDC to escrow ${escrow}`, source: SOURCE, authorizationDigest: signed.digest, simulated: true });
    await purchases.transition(purchaseId, "PAYMENT_PENDING", { reason: "authorization handed to the facilitator /settle", source: SOURCE, authorizationDigest: signed.digest, simulated: true });
    const requirements = requirementFor(escrow, amount.toString());
    const settled = await deps.facilitator.settle({ payload: buildPaymentPayload({ accepted: requirements, signed }), requirements, forceBroadcast: false });
    if (settled.outcome === "paid") {
      outcome.txs["settle"] = settled.txHash;
      log(`${tag} ${spec.behaviour}: settle() paid ${amount} to ${escrow} in ${settled.txHash} (node ${settled.nodeId})`);
    } else if (settled.outcome === "unknown") {
      await purchases.transition(purchaseId, "PAYMENT_UNKNOWN", { reason: `settle outcome unknown: ${settled.reason}`, source: SOURCE, simulated: true });
      outcome.lastStep = `settle unknown: ${settled.reason}`;
      log(`${tag} ${spec.behaviour}: settle unknown (${settled.reason}); the indexer reconciles, nothing is retried`);
      continue;
    } else {
      await purchases.transition(purchaseId, "REJECTED", { reason: `settle refused: ${settled.decoded.reason}`, source: SOURCE, decodedRevert: settled.decoded.decoded, simulated: true });
      outcome.lastStep = `settle blocked: ${settled.decoded.decoded}`;
      log(`${tag} ${spec.behaviour}: settle blocked ${settled.decoded.decoded}; order left unfunded`);
      continue;
    }
    outcome.txs["markFunded"] = await relay(`escrow.markFunded(${spec.behaviour})`, escrow, overflowEscrowAbi, "markFunded", []);
    outcome.lastStep = "markFunded";
  }

  // ---- Phase B: reveal (or not), accept, complain ---------------------------------------------------------------
  const funded = live.filter((o) => o.outcome.lastStep === "markFunded");
  for (const o of funded) {
    if (!o.seller.willReveal()) {
      log(`${tag} ghost: seller never calls revealKey; reveal deadline ${o.revealDeadline}`);
      o.outcome.lastStep = "awaiting timeout";
      continue;
    }
    o.outcome.txs["revealKey"] = await sellerSend(o.seller, `escrow.revealKey(${o.spec.behaviour})`, o.escrow, overflowEscrowAbi, "revealKey", [o.k]);
    // Buyer decrypts the delivery and checks every chunk against the manifest's committed leaves.
    const scan = findFirstMismatch(o.order.cipherChunks, o.dataset.plainLeaves, o.k);
    if (scan.index === undefined) {
      const plain = decryptDataset(o.order.cipherChunks, o.k);
      if (!plain.every((c, i) => hashLeaf(c).toLowerCase() === o.dataset.plainLeaves[i]!.toLowerCase())) throw new Error("decrypted dataset disagrees with the scan");
      log(`${tag} ${o.spec.behaviour}: all ${scan.checked} chunks decrypt to the committed leaves; accepting delivery`);
      const digest = (await deps.chain.readContract({ address: o.escrow, abi: overflowEscrowAbi, functionName: "acceptDigest" })) as Hex;
      const sig = await deps.accounts.rootNode.sign({ hash: digest });
      o.outcome.txs["accept"] = await relay(`escrow.accept(${o.spec.behaviour})`, o.escrow, overflowEscrowAbi, "accept", [sig]);
      o.outcome.lastStep = "accept";
      continue;
    }
    log(`${tag} ${o.spec.behaviour}: chunk ${scan.index} does not decrypt to its committed leaf (checked ${scan.checked}); building complainMismatch`);
    const evidence = buildMismatchEvidence({ index: scan.index, cipherChunks: o.order.cipherChunks, plainLeaves: o.dataset.plainLeaves, revealedKey: o.k, rootCipher: o.order.rootCipher, rootPlain: o.order.rootPlain, chunkCount: o.order.chunkCount });
    const complaint = await repos.complaints.insert({
      purchaseId: o.purchaseId,
      escrowAddress: o.escrow,
      kind: "mismatch",
      chunkIndex: evidence.chunkIndex,
      chunk: evidence.chunk,
      cipherProof: evidence.cipherProof,
      plainLeaf: evidence.plainLeaf,
      plainProof: evidence.plainProof,
      derivedLeaf: evidence.derivedLeaf,
      revealedKey: o.k,
      ...(evidence.decryptedRow !== undefined ? { decryptedRow: evidence.decryptedRow } : {}),
      cipherProofVerified: evidence.cipherProofVerified,
      plainProofVerified: evidence.plainProofVerified,
      cheatVerified: evidence.cheatVerified,
      detail: evidence.detail,
      simulated: true,
    });
    await note("complaint.built", `complainMismatch built for chunk ${evidence.chunkIndex}: cipher proof ${evidence.cipherProofVerified ? "ok" : "FAILED"}, plain proof ${evidence.plainProofVerified ? "ok" : "FAILED"}, derived leaf ${evidence.derivedLeaf} != committed ${evidence.plainLeaf}`, o.purchaseId);
    try {
      const hash = await relay(`escrow.complainMismatch(${o.spec.behaviour}, ${evidence.chunkIndex})`, o.escrow, overflowEscrowAbi, "complainMismatch", [BigInt(evidence.chunkIndex), evidence.chunk, evidence.cipherProof, evidence.plainLeaf, evidence.plainProof]);
      await repos.complaints.setStatus(complaint.id, "submitted", { txHash: hash });
      o.outcome.txs["complainMismatch"] = hash;
      o.outcome.lastStep = "complainMismatch";
    } catch (e) {
      await repos.complaints.setStatus(complaint.id, "rejected");
      throw e;
    }
  }

  // ---- Clock warp: past every reveal deadline, so the ghost's refund is claimable -------------------------------
  const warpedTo = await increaseTime(rpcUrl, WARP_SECONDS);
  log(`${tag} evm_increaseTime(${WARP_SECONDS}): chain clock now ${warpedTo}`);
  for (const o of funded.filter((x) => x.outcome.lastStep === "awaiting timeout")) {
    if (warpedTo < o.revealDeadline) throw new Error(`ghost: clock ${warpedTo} still before reveal deadline ${o.revealDeadline}`);
    o.outcome.txs["claimTimeoutRefund"] = await relay("escrow.claimTimeoutRefund(ghost)", o.escrow, overflowEscrowAbi, "claimTimeoutRefund", []);
    o.outcome.lastStep = "claimTimeoutRefund";
  }
  await mine(rpcUrl, 2);

  for (const o of live) log(`${tag} ${o.spec.behaviour}: purchase ${o.purchaseId}, escrow ${o.escrow}, last step ${o.outcome.lastStep}; the indexer sets the status from chain events`);
  return { orders: live.map((o) => o.outcome), warpedSeconds: WARP_SECONDS };
}

/** Purchase statuses the indexer should reach for each order once it catches up; used by logs and docs, never by the UI. */
export const EXPECTED_FINAL_STATUS: Record<SellerBehaviour, PurchaseStatus> = { honest: "SETTLED", ghost: "REFUNDED", swap: "REFUNDED" };
