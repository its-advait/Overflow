import { createRepositories, type Db } from "@overflow/database";
import { signAccept } from "@overflow/payment-client";
import {
  buildMismatchComplaint,
  buildPromiseComplaint,
  buildTree,
  checkMismatch,
  ComplaintNotWarrantedError,
  DatasetManifestSchema,
  decryptChunk,
  hashLeaf,
  splitDataset,
  verifyCiphertext,
  verifyRecordPromise,
} from "@overflow/recourse-crypto";
import { overflowEscrowAbi, type ActivityEvent, type ActivityKind, type Address, type EscrowOrder, type Hex, type PurchaseRecord } from "@overflow/schemas";
import { encodeFunctionData, zeroAddress } from "viem";
import type { PaymentAdapter } from "../api/ports.js";
import type { ActivityBus, BusMessage } from "../chain/bus.js";
import type { ChainClient } from "../chain/client.js";
import { decodeRevert } from "../facilitator/decode.js";
import type { Relayer } from "../facilitator/relayer.js";
import type { NodeSigners } from "../payment/node-signers.js";
import type { RecourseChainReads } from "../sellers/recourse/chain.js";
import type { PurchaseService } from "./purchase-service.js";
import type { SampleCache, SampleFetch, SampleJudge } from "./sample-judgment.js";

// ---------------------------------------------------------------------------
// Step 9 of docs/SPEC.md "One purchase, end to end" plus the failure sweeps,
// as a poll-driven watcher over the purchases table.
//
//   DELIVERY_PENDING  the seller revealed k: decrypt every chunk, compare with the
//                     committed plain leaves (tier 2) and, when the terms promise a
//                     source, verify every record's signature and timestamp
//                     (tier 3). All good -> the paying node signs Accept and the
//                     relayer sends escrow.accept(sig). A bad chunk -> the matching
//                     complaint with its Merkle proofs. The contract decides.
//   ESCROW_FUNDED     the seller never revealed and the deadline passed ->
//                     escrow.claimTimeoutRefund().
//   PAYMENT_UNKNOWN   the adapter reconciles the authorization against USDC;
//                     only a definite "not settled" ends the purchase.
//
// Write discipline (the seller worker's): simulate first, then one relayer
// submission; an in-memory `submitted` set plus a fresh escrow.status() read
// before every send so neither a tick nor a restart double-submits; a reverted
// or unknown outcome is recorded as `delivery.action-failed` and never retried
// with new arguments. The watcher records *submissions*. SETTLED and REFUNDED
// come only from the indexer's PaidOut / Refunded handlers; nothing here sets a
// chain-truth status, and nothing here moves USDC (OverflowEscrow does).
// ---------------------------------------------------------------------------

/** Seconds past revealDeadline before claimTimeoutRefund (the contract compares block.timestamp > revealDeadline; blocks every ~2 s). */
export const TIMEOUT_MARGIN_S = 2n;

export type DeliveryAction = "accept" | "complainMismatch" | "complainPromise" | "claimTimeoutRefund";

export interface DeliveryWatcher {
  start(): void;
  stop(): void;
  /** One sweep; a call made while a sweep runs waits for it and triggers one more sweep (never two at once). */
  tick(): Promise<void>;
  /** One line for GET / : running/stopped, submission counts, last tick. */
  status(): string;
}

/** The chain reads the watcher needs; `viemRecourseReads` satisfies it, so does the test fake. */
export type DeliveryReads = Pick<RecourseChainReads, "status" | "challengeEnd" | "blockTimestamp">;
export type DeliverySimulator = Pick<ChainClient, "simulateContract">;
export type DeliveryRelayer = Pick<Relayer, "address" | "submit">;

export interface DeliveryWatcherDeps {
  db: Db;
  bus: ActivityBus;
  purchases: PurchaseService;
  /** The step 4 judge's cache of cipher chunks + plain leaves; undefined after a restart, then re-fetched from the seller. */
  judge: Pick<SampleJudge, "cached">;
  /** Base URL of the SIMULATED Recourse seller app (URLs rebuilt from order id and resource id, as in sample-judgment.ts). */
  sellerUrl: string;
  fetch: SampleFetch;
  nodeSigners: Pick<NodeSigners, "signerFor">;
  reads: DeliveryReads;
  chain: DeliverySimulator;
  relayer: DeliveryRelayer;
  adapter: Pick<PaymentAdapter, "reconcilePayment">;
  /** Our treasury: the watcher acts only on purchases this treasury paid for. */
  treasury: Address;
  intervalMs: number;
  now?: (() => Date) | undefined;
  log?: ((line: string) => void) | undefined;
}

type Verdict =
  | { kind: "accept" }
  | { kind: "mismatch"; index: number; detail: string }
  | { kind: "promise"; index: number; detail: string }
  | { kind: "unverifiable"; detail: string };

export function createDeliveryWatcher(deps: DeliveryWatcherDeps): DeliveryWatcher {
  const repos = createRepositories(deps.db);
  const log = deps.log ?? ((line: string) => console.log(`[delivery] ${line}`));
  const now = deps.now ?? (() => new Date());

  let timer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;
  let inFlight: Promise<void> | null = null;
  let rerun = false;
  let ticks = 0;
  let lastTickAt: string | null = null;
  let lastError: string | null = null;
  const counts = { accepts: 0, complaints: 0, timeouts: 0, failures: 0 };

  /** `${purchaseId}:${action}` once a send was attempted (sent, reverted, unknown or refused by simulation). Never retried in-process. */
  const submitted = new Set<string>();
  /** Problems already recorded once per purchase (so a stuck purchase does not write an event every tick). */
  const noted = new Set<string>();

  // ------------------------------------------------------------------ events

  async function record(purchase: PurchaseRecord, kind: ActivityKind, message: string, extra: { txHash?: Hex; simulated: boolean }): Promise<ActivityEvent> {
    const event = await repos.activityEvents.insert({
      kind,
      message,
      purchaseId: purchase.id,
      missionId: purchase.missionId,
      ...(extra.txHash ? { txHash: extra.txHash } : {}),
      simulated: extra.simulated,
    });
    try {
      deps.bus.publish(event);
    } catch (e) {
      console.warn("[delivery] publish hook threw", e);
    }
    log(`${purchase.id} ${kind}: ${message}`);
    return event;
  }

  async function failed(purchase: PurchaseRecord, simulated: boolean, message: string, onceKey?: string): Promise<void> {
    if (onceKey) {
      if (noted.has(onceKey)) return;
      noted.add(onceKey);
    }
    counts.failures++;
    await record(purchase, "delivery.action-failed", message, { simulated });
  }

  async function simulatedFlag(purchase: PurchaseRecord): Promise<boolean> {
    const resource = await repos.resources.getById(purchase.resourceId);
    return resource?.simulated ?? false;
  }

  // ------------------------------------------------------------------ one contract write

  type WriteOutcome = { status: "success"; hash: Hex } | { status: "failed"; message: string };

  /**
   * Simulate, then submit through the relayer. The `submitted` key is set before anything leaves the process, so
   * a second tick (or a thrown error after the send) never sends again. The caller re-read escrow.status() first.
   */
  async function write(purchase: PurchaseRecord, escrow: Address, action: DeliveryAction, args: readonly unknown[]): Promise<WriteOutcome> {
    const key = `${purchase.id}:${action}`;
    if (submitted.has(key)) return { status: "failed", message: `${action} already attempted for ${purchase.id} in this process; not resent` };
    submitted.add(key);
    const call = { address: escrow, abi: overflowEscrowAbi, functionName: action, args };
    try {
      await deps.chain.simulateContract({ ...call, account: deps.relayer.address });
    } catch (e) {
      const d = decodeRevert(e);
      return { status: "failed", message: `${action} simulation reverted at escrow ${escrow}: ${d.reason}; not sent` };
    }
    const data = encodeFunctionData(call as unknown as Parameters<typeof encodeFunctionData>[0]);
    const r = await deps.relayer.submit({ to: escrow, data, label: `delivery ${action} ${purchase.id}` });
    if (r.status === "success") return { status: "success", hash: r.hash };
    if (r.status === "reverted") return { status: "failed", message: `${action} reverted on chain in tx ${r.hash} (escrow ${escrow}); not retried` };
    return { status: "failed", message: `${action} outcome unknown for tx ${r.hash} (escrow ${escrow}): ${r.error}; not retried, the escrow status is re-read next tick` };
  }

  // ------------------------------------------------------------------ step 9: verify the revealed delivery

  async function fetchCipher(order: EscrowOrder): Promise<Uint8Array[]> {
    const url = `${deps.sellerUrl}/orders/${order.orderIdBytes32}/cipher`;
    const res = await deps.fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return splitDataset(new Uint8Array(await res.arrayBuffer()));
  }

  async function fetchManifest(resourceId: string) {
    const url = `${deps.sellerUrl}/r/${resourceId}/manifest`;
    const res = await deps.fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return DatasetManifestSchema.parse(await res.json());
  }

  /** The judge's cache, or a re-fetch from the seller. Either way the data must Merkle to the escrow's commitments. */
  async function deliveryData(purchase: PurchaseRecord, order: EscrowOrder): Promise<SampleCache | { error: string }> {
    let data = deps.judge.cached(purchase.id);
    if (!data) {
      try {
        const cipherChunks = await fetchCipher(order);
        const manifest = await fetchManifest(purchase.resourceId);
        data = { cipherChunks, plainLeaves: manifest.plainLeaves as Hex[], manifest };
      } catch (e) {
        return { error: `could not re-fetch the delivery from the seller: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const n = data.cipherChunks.length;
    if (!verifyCiphertext(data.cipherChunks, order.rootCipher, n)) return { error: `ciphertext (${n} chunks) does not Merkle to the escrow's rootCipher ${order.rootCipher}` };
    if (data.manifest.rootPlain.toLowerCase() !== order.rootPlain.toLowerCase()) return { error: `manifest rootPlain ${data.manifest.rootPlain} differs from the escrow's ${order.rootPlain}` };
    if (data.plainLeaves.length !== n) return { error: `manifest has ${data.plainLeaves.length} plain leaves for ${n} ciphertext chunks` };
    if (buildTree(data.plainLeaves).root.toLowerCase() !== order.rootPlain.toLowerCase()) return { error: `manifest plainLeaves do not Merkle to rootPlain ${order.rootPlain}` };
    return data;
  }

  /** Tier 2 on every chunk, then tier 3 on every chunk when the terms promise a source. The first bad chunk decides. */
  async function verifyDelivery(order: EscrowOrder, key: Hex, data: SampleCache): Promise<Verdict> {
    const promised = order.sourceKey.toLowerCase() !== zeroAddress;
    const promise = { sourceKey: order.sourceKey, minTimestamp: BigInt(order.minTimestamp) };
    for (let i = 0; i < data.cipherChunks.length; i++) {
      const cipher = data.cipherChunks[i]!;
      const check = checkMismatch(i, cipher, key, data.plainLeaves[i]!);
      if (check.mismatch) return { kind: "mismatch", index: i, detail: `chunk ${i} decrypts to leaf ${check.derivedLeaf}, committed ${check.committedLeaf}` };
      if (promised) {
        const v = await verifyRecordPromise(decryptChunk(cipher, key, i), promise);
        if (!v.ok) return { kind: "promise", index: i, detail: `record ${i} ${v.reason}: ${v.detail}` };
      }
    }
    return { kind: "accept" };
  }

  async function onDeliveryPending(purchase: PurchaseRecord): Promise<void> {
    const order = await repos.escrowOrders.getByPurchase(purchase.id);
    if (!order || order.status !== "Revealed" || !order.revealedKey) return;
    if (purchase.buyerTreasury.toLowerCase() !== deps.treasury.toLowerCase()) {
      if (!noted.has(`${purchase.id}:treasury`)) {
        noted.add(`${purchase.id}:treasury`);
        log(`${purchase.id}: buyer ${purchase.buyerTreasury} is not our treasury ${deps.treasury}; not acting`);
      }
      return;
    }
    const escrow = order.escrowAddress;
    const actions: DeliveryAction[] = ["accept", "complainMismatch", "complainPromise"];
    if (actions.some((a) => submitted.has(`${purchase.id}:${a}`))) return;
    // Cheap chain read before downloading anything: a closed escrow (seller's finalizePayout, an earlier complaint) needs no verification.
    const early = await deps.reads.status(escrow);
    if (early !== "Revealed") {
      log(`${purchase.id}: escrow ${escrow} is ${early} on chain, not Revealed; nothing to verify (the indexer moves the purchase)`);
      return;
    }
    const simulated = await simulatedFlag(purchase);

    const data = await deliveryData(purchase, order);
    if ("error" in data) {
      await failed(purchase, simulated, `delivery of escrow ${escrow} cannot be verified: ${data.error}; nothing submitted`, `${purchase.id}:data`);
      return;
    }
    const key = order.revealedKey;
    const verdict = await verifyDelivery(order, key, data);

    // Re-read the chain right before sending: the seller's finalizePayout or an earlier complaint may have closed the escrow.
    const live = await deps.reads.status(escrow);
    if (live !== "Revealed") {
      log(`${purchase.id}: escrow ${escrow} is ${live} on chain, not Revealed; nothing to submit (the indexer moves the purchase)`);
      return;
    }

    const n = data.cipherChunks.length;
    if (verdict.kind === "accept") {
      await record(purchase, "delivery.verified", `all ${n} chunks of escrow ${escrow} decrypt with the revealed key to the committed plain leaves${order.sourceKey.toLowerCase() !== zeroAddress ? ` and every record is signed by ${order.sourceKey} at or after ${order.minTimestamp}` : ""}`, { simulated });
      const signer = await deps.nodeSigners.signerFor(purchase.payingNodeId);
      const sig = await signAccept(signer.account, escrow, order.orderIdBytes32);
      const r = await write(purchase, escrow, "accept", [sig]);
      if (r.status === "success") {
        counts.accepts++;
        await record(purchase, "delivery.accept-submitted", `accept(sig) by ${signer.agentId} (node ${purchase.payingNodeId}) confirmed in tx ${r.hash}; the escrow pays the seller, PaidOut settles the purchase`, { txHash: r.hash, simulated });
      } else {
        await failed(purchase, simulated, r.message);
      }
      return;
    }

    if (verdict.kind === "mismatch") {
      let args;
      try {
        args = buildMismatchComplaint({ index: verdict.index, cipherChunks: data.cipherChunks, plainLeaves: data.plainLeaves, revealedKey: key, rootCipher: order.rootCipher, rootPlain: order.rootPlain });
      } catch (e) {
        if (!(e instanceof ComplaintNotWarrantedError)) throw e;
        await failed(purchase, simulated, `mismatch at chunk ${verdict.index} but the complaint is not warranted: ${e.message}`, `${purchase.id}:complaint`);
        return;
      }
      const r = await write(purchase, escrow, "complainMismatch", [args.i, args.cipherChunk, args.cipherProof, args.plainLeaf, args.plainProof]);
      if (r.status === "success") {
        counts.complaints++;
        await record(purchase, "delivery.complaint-submitted", `complainMismatch(${verdict.index}) confirmed in tx ${r.hash}: ${verdict.detail}; Refunded moves the purchase`, { txHash: r.hash, simulated });
      } else {
        await failed(purchase, simulated, `${r.message} (${verdict.detail})`);
      }
      return;
    }

    if (verdict.kind === "promise") {
      const plainChunks = data.cipherChunks.map((c, i) => decryptChunk(c, key, i));
      let args;
      try {
        args = await buildPromiseComplaint({ index: verdict.index, plainChunks, sourceKey: order.sourceKey, minTimestamp: BigInt(order.minTimestamp), rootPlain: order.rootPlain });
      } catch (e) {
        if (!(e instanceof ComplaintNotWarrantedError)) throw e;
        await failed(purchase, simulated, `broken promise at record ${verdict.index} but the complaint is not warranted: ${e.message}`, `${purchase.id}:complaint`);
        return;
      }
      const r = await write(purchase, escrow, "complainPromise", [args.i, args.plainChunk, args.plainProof]);
      if (r.status === "success") {
        counts.complaints++;
        await record(purchase, "delivery.complaint-submitted", `complainPromise(${verdict.index}) confirmed in tx ${r.hash}: ${verdict.detail}; Refunded moves the purchase`, { txHash: r.hash, simulated });
      } else {
        await failed(purchase, simulated, `${r.message} (${verdict.detail})`);
      }
      return;
    }

    await failed(purchase, simulated, `delivery of escrow ${escrow} cannot be verified: ${verdict.detail}`, `${purchase.id}:data`);
  }

  // ------------------------------------------------------------------ ghost seller: timeout refund

  async function onEscrowFunded(purchase: PurchaseRecord): Promise<void> {
    const order = await repos.escrowOrders.getByPurchase(purchase.id);
    if (!order) return;
    if (submitted.has(`${purchase.id}:claimTimeoutRefund`)) return;
    if (purchase.buyerTreasury.toLowerCase() !== deps.treasury.toLowerCase()) return;
    const deadline = BigInt(order.revealDeadline);
    const ts = await deps.reads.blockTimestamp();
    if (ts < deadline + TIMEOUT_MARGIN_S) return;
    const escrow = order.escrowAddress;
    const live = await deps.reads.status(escrow);
    if (live !== "Funded") {
      log(`${purchase.id}: escrow ${escrow} is ${live} on chain, not Funded; no timeout claim`);
      return;
    }
    const simulated = await simulatedFlag(purchase);
    const r = await write(purchase, escrow, "claimTimeoutRefund", []);
    if (r.status === "success") {
      counts.timeouts++;
      await record(purchase, "delivery.timeout-claimed", `claimTimeoutRefund() confirmed in tx ${r.hash}: no key revealed by ${order.revealDeadline} (chain time ${ts}); Refunded moves the purchase and restores treasury USDC`, { txHash: r.hash, simulated });
    } else {
      await failed(purchase, simulated, r.message);
    }
  }

  // ------------------------------------------------------------------ PAYMENT_UNKNOWN: reconcile

  async function onPaymentUnknown(purchase: PurchaseRecord): Promise<void> {
    const r = await deps.adapter.reconcilePayment(purchase.id);
    if (r.status !== "not-settled") return; // funded: the indexer's OrderFunded handler moves it; unknown: ask again next tick
    const simulated = await simulatedFlag(purchase);
    await deps.purchases.transition(purchase.id, "FAILED_BEFORE_FUNDING", {
      reason: "reconciliation: the authorization was never executed by USDC and its validBefore has passed; no funds moved",
      source: { kind: "reconciliation", reference: purchase.authorizationDigest ?? purchase.id },
      simulated,
    });
    log(`${purchase.id}: PAYMENT_UNKNOWN -> FAILED_BEFORE_FUNDING (not settled)`);
  }

  // ------------------------------------------------------------------ the sweep

  async function sweep(status: PurchaseRecord["status"], handler: (p: PurchaseRecord) => Promise<void>): Promise<void> {
    for (const purchase of await repos.purchases.listByStatus(status)) {
      try {
        await handler(purchase);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        log(`${purchase.id} (${status}) tick error: ${lastError}`);
      }
    }
  }

  async function runOnce(): Promise<void> {
    ticks++;
    lastTickAt = now().toISOString();
    await sweep("DELIVERY_PENDING", onDeliveryPending);
    await sweep("ESCROW_FUNDED", onEscrowFunded);
    await sweep("PAYMENT_UNKNOWN", onPaymentUnknown);
  }

  function tick(): Promise<void> {
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        rerun = false;
        await runOnce();
      } while (rerun);
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  const onBus = (msg: BusMessage): void => {
    if (msg.type !== "activity") return;
    if (msg.event.kind === "purchase.status" || msg.event.kind === "escrow.revealed") void tick();
  };

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), deps.intervalMs);
      timer.unref?.();
      unsubscribe = deps.bus.subscribe(onBus);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
    status: () =>
      `${timer ? "running" : "stopped"}, ${ticks} tick(s), accepts=${counts.accepts} complaints=${counts.complaints} timeouts=${counts.timeouts} failures=${counts.failures}, last tick ${lastTickAt ?? "never"}${lastError ? `, last error: ${lastError}` : ""}`,
  };
}
