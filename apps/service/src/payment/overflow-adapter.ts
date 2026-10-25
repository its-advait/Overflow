import {
  buildPaymentHeader,
  buildPaymentPayload,
  parsePaymentRequired,
  parsePaymentResponse,
  selectRequirements,
  signTransfer,
  X402_HEADERS,
  type CheckedQuote,
  type PaymentRequirements,
} from "@overflow/payment-client";
import { overflowTreasuryAbi, USDC, type Address, type Hex, type PurchaseOrder, type ResourceRecord } from "@overflow/schemas";
import { z } from "zod";
import type { PaymentAdapter, PaymentStatus, PaymentSubmission, PreparedPayment } from "../api/ports.js";
import { QUOTE_TIMEOUT_SECONDS } from "../sellers/prices.js";
import type { NodeOfKeyReader, NodeSigners } from "./node-signers.js";

// ---------------------------------------------------------------------------
// PaymentAdapter for the "overflow-facilitator" path (docs/SPEC.md "One payment
// interface, two paths"). The seller's x402 paywall (GET /r/:id?order=) settles
// through the in-process facilitator, which calls treasury.settle(); this module
// only fetches the quote, signs one EIP-3009 authorization with the paying node's
// key (from = treasury, to = the per-order escrow) and sends the paid retry once.
// It never moves USDC, never re-signs, and reports funding only from the
// seller's PAYMENT-RESPONSE or from USDC.authorizationState on chain. Status
// changes belong to the route and the indexer, not to this adapter.
// ---------------------------------------------------------------------------

export class SellerQuoteError extends Error {
  constructor(
    public readonly reason: string,
    public readonly details?: unknown,
  ) {
    super(`seller quote unusable: ${reason}`);
    this.name = "SellerQuoteError";
  }
}

/** preparePayment was already called for this purchase; the first authorization is the only one. */
export class AuthorizationInFlightError extends Error {
  constructor(
    public readonly purchaseId: string,
    public readonly authorizationDigest: Hex,
  ) {
    super(`purchase ${purchaseId} already has authorization ${authorizationDigest}; never sign a second one`);
    this.name = "AuthorizationInFlightError";
  }
}

/** submitPayment was already called for this purchase; reconcile, never resend. */
export class AlreadySubmittedError extends Error {
  constructor(
    public readonly purchaseId: string,
    public readonly authorizationDigest: Hex,
  ) {
    super(`purchase ${purchaseId} payment ${authorizationDigest} was already submitted; reconcile instead of resending`);
    this.name = "AlreadySubmittedError";
  }
}

/** The order's authorization window has closed; nothing is signed. */
export class AuthorizationWindowClosedError extends Error {
  constructor(
    public readonly purchaseId: string,
    public readonly authorizationExpiresAt: string,
  ) {
    super(`purchase ${purchaseId} authorization window closed at ${authorizationExpiresAt}; not signing`);
    this.name = "AuthorizationWindowClosedError";
  }
}

/** submitPayment called with a PreparedPayment this adapter did not produce (or after a restart). */
export class UnknownPreparedPaymentError extends Error {
  constructor(
    public readonly purchaseId: string,
    public readonly authorizationDigest: Hex,
  ) {
    super(`purchase ${purchaseId}: no prepared authorization ${authorizationDigest} in this process; reconcile instead`);
    this.name = "UnknownPreparedPaymentError";
  }
}

/** Chain reads reconciliation needs; tests pass a fake, index.ts passes viemAdapterChain(). */
export interface AdapterChainReads {
  /** USDC.authorizationState(authorizer, nonce): true once the nonce was consumed by a transfer. */
  authorizationState(authorizer: Address, nonce: Hex): Promise<boolean>;
  /** The treasury Paid event carrying this nonce, when a log scan is available. */
  findPaidTx?(nonce: Hex): Promise<Hex | null>;
}

/** What one signed authorization looks like while it lives; money stays a decimal string. */
export interface PreparedRecord {
  purchaseId: string;
  url: string;
  requirements: PaymentRequirements;
  digest: Hex;
  nonce: Hex;
  payTo: Address;
  valueAtomic: string;
  validBefore: string;
  signerAddress: Address;
  nodeId: number;
  /** The PAYMENT-SIGNATURE header value (base64 PaymentPayload). */
  header: string;
  submission?: PaymentSubmission | undefined;
  submittedAt?: string | undefined;
}

/** Where prepared authorizations live. The default is in-memory; a persistent store survives restarts. */
export interface PreparedStore {
  get(purchaseId: string): Promise<PreparedRecord | undefined>;
  set(record: PreparedRecord): Promise<void>;
}

export function inMemoryPreparedStore(): PreparedStore {
  const m = new Map<string, PreparedRecord>();
  return {
    get: async (id) => m.get(id),
    set: async (r) => {
      m.set(r.purchaseId, r);
    },
  };
}

export interface OverflowFacilitatorAdapterOptions {
  /** Base URL of the seller app, e.g. SELLER_URL. */
  sellerUrl: string;
  /** How to reach the seller; index.ts passes the seller Hono app's `app.request` so no socket is needed in-process. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The deployed treasury: the only `from` these authorizations may name. */
  treasury: Address;
  /** Agent keys, resolved per paying node against treasury.nodeOfKey. */
  nodeSigners: NodeSigners;
  chain: AdapterChainReads;
  store?: PreparedStore | undefined;
  now?: (() => Date) | undefined;
  /** Abort the paid retry after this long; an abort is an unknown outcome, never a retry. */
  timeoutMs?: number | undefined;
  log?: ((line: string) => void) | undefined;
}

const BlockedBody = z.object({
  error: z.string(),
  decoded: z.object({ name: z.string(), args: z.array(z.string()).default([]), reason: z.string().optional() }).partial().optional(),
  txHash: z.string().optional(),
});

const TxHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** `${sellerUrl}/r/${resourceId}?order=${orderIdBytes32}`: the seller app's own URL shape (sellers/recourse/routes.ts). */
export function resourceUrl(sellerUrl: string, resourceId: string, orderIdBytes32: Hex): string {
  return `${sellerUrl.replace(/\/$/, "")}/r/${encodeURIComponent(resourceId)}?order=${orderIdBytes32}`;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.name === "AbortError" || e.name === "TimeoutError" ? `timeout: ${e.message}` : `${e.name}: ${e.message}`;
  return String(e);
}

export function createOverflowFacilitatorAdapter(opts: OverflowFacilitatorAdapterOptions): PaymentAdapter {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const store = opts.store ?? inMemoryPreparedStore();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  /** Same-process guard against two concurrent prepares/submits racing past the store's async get. */
  const inProgress = new Set<string>();

  async function fetchSeller(url: string, headers: Record<string, string>): Promise<Response> {
    return opts.fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  }

  async function nowSeconds(): Promise<number> {
    return Math.floor(now().getTime() / 1000);
  }

  return {
    path: "overflow-facilitator",

    async getPaymentRequirements(order: PurchaseOrder, resource: ResourceRecord): Promise<PaymentRequirements> {
      if (order.resourceId !== resource.id) throw new SellerQuoteError("order and resource disagree", { order: order.resourceId, resource: resource.id });
      const url = resourceUrl(opts.sellerUrl, resource.id, order.orderIdBytes32);
      let res: Response;
      try {
        res = await fetchSeller(url, {});
      } catch (e) {
        throw new SellerQuoteError("seller unreachable", { url, error: describeError(e) });
      }
      if (res.status !== 402) {
        throw new SellerQuoteError(`expected 402 Payment Required, seller answered ${res.status}`, { url, status: res.status, body: (await res.text()).slice(0, 500) });
      }
      let required;
      try {
        required = parsePaymentRequired(res);
      } catch (e) {
        throw new SellerQuoteError("PAYMENT-REQUIRED header failed its schema", { url, error: describeError(e) });
      }
      const selected = selectRequirements(required);
      if (!selected) throw new SellerQuoteError("no exact/eip155:84532/USDC requirement offered", { url, accepts: required.accepts });
      log(`[adapter:overflow-facilitator] quote for ${order.id}: ${selected.amount} atomic to ${selected.payTo} (${url})`);
      return selected;
    },

    async preparePayment(purchaseId: string, quote: CheckedQuote): Promise<PreparedPayment> {
      if (inProgress.has(purchaseId)) throw new AuthorizationInFlightError(purchaseId, `0x${"0".repeat(64)}`);
      inProgress.add(purchaseId);
      try {
        const existing = await store.get(purchaseId);
        if (existing) throw new AuthorizationInFlightError(purchaseId, existing.digest);
        const order = quote.order;
        if (order.id !== purchaseId) throw new SellerQuoteError("quote belongs to another purchase", { purchaseId, quoteOrder: order.id });
        if (order.buyerTreasury.toLowerCase() !== opts.treasury.toLowerCase()) {
          throw new SellerQuoteError("order treasury differs from the deployed treasury", { order: order.buyerTreasury, treasury: opts.treasury });
        }

        // validBefore = min(order.authorizationExpiresAt, now + QUOTE_TIMEOUT_SECONDS); nothing is signed past the window.
        const nowSec = await nowSeconds();
        const expiresSec = Math.floor(new Date(order.authorizationExpiresAt).getTime() / 1000);
        const ttlSeconds = Math.min(expiresSec - nowSec, QUOTE_TIMEOUT_SECONDS);
        if (!(ttlSeconds > 0)) throw new AuthorizationWindowClosedError(purchaseId, order.authorizationExpiresAt);

        // The paying node's key, confirmed by treasury.nodeOfKey; no fallback to another key.
        const signer = await opts.nodeSigners.signerFor(order.payingNodeId);

        const signed = await signTransfer({
          nodeAccount: signer.account,
          treasury: opts.treasury,
          to: quote.payTo,
          value: quote.value,
          ttlSeconds,
          reservationWindowSeconds: ttlSeconds,
          nowSeconds: nowSec,
        });
        const payload = buildPaymentPayload({ accepted: quote.requirements, signed });
        const header = buildPaymentHeader(payload);
        const record: PreparedRecord = {
          purchaseId,
          url: resourceUrl(opts.sellerUrl, order.resourceId, order.orderIdBytes32),
          requirements: quote.requirements,
          digest: signed.digest,
          nonce: signed.authorization.nonce,
          payTo: quote.payTo,
          valueAtomic: quote.valueAtomic,
          validBefore: signed.authorization.validBefore.toString(),
          signerAddress: signer.account.address,
          nodeId: signer.nodeId,
          header: header.value,
        };
        await store.set(record);
        log(`[adapter:overflow-facilitator] ${purchaseId}: ${signer.agentId} (node ${signer.nodeId}) signed ${signed.digest} for ${record.valueAtomic} atomic to ${record.payTo}, validBefore ${record.validBefore}`);
        return { authorizationDigest: signed.digest };
      } finally {
        inProgress.delete(purchaseId);
      }
    },

    async submitPayment(purchaseId: string, prepared: PreparedPayment): Promise<PaymentSubmission> {
      if (inProgress.has(purchaseId)) {
        throw new AlreadySubmittedError(purchaseId, prepared.authorizationDigest);
      }
      inProgress.add(purchaseId);
      try {
        const record = await store.get(purchaseId);
        if (!record || record.digest !== prepared.authorizationDigest) throw new UnknownPreparedPaymentError(purchaseId, prepared.authorizationDigest);
        if (record.submission || record.submittedAt) throw new AlreadySubmittedError(purchaseId, record.digest);

        // Mark before the request leaves so a crash mid-flight can never lead to a second send.
        record.submittedAt = now().toISOString();
        await store.set(record);

        const submission = await send(record);
        record.submission = submission;
        await store.set(record);
        return submission;
      } finally {
        inProgress.delete(purchaseId);
      }
    },

    async reconcilePayment(purchaseId: string): Promise<PaymentStatus> {
      const record = await store.get(purchaseId);
      if (!record) {
        log(`[adapter:overflow-facilitator] reconcile ${purchaseId}: no authorization record in this store (restart?); cannot read authorizationState without the nonce`);
        return { status: "unknown" };
      }
      let consumed: boolean;
      try {
        consumed = await opts.chain.authorizationState(opts.treasury, record.nonce);
      } catch (e) {
        log(`[adapter:overflow-facilitator] reconcile ${purchaseId}: authorizationState read failed: ${describeError(e)}`);
        return { status: "unknown" };
      }
      if (consumed) {
        const fromSubmission = record.submission?.outcome === "submitted" ? record.submission.txHash : undefined;
        const txHash = fromSubmission ?? (opts.chain.findPaidTx ? await opts.chain.findPaidTx(record.nonce).catch(() => null) : null);
        if (txHash) return { status: "funded", txHash };
        log(`[adapter:overflow-facilitator] reconcile ${purchaseId}: nonce ${record.nonce} consumed on chain but no Paid tx found yet`);
        return { status: "unknown" };
      }
      const nowSec = await nowSeconds();
      if (BigInt(nowSec) > BigInt(record.validBefore)) return { status: "not-settled" };
      return { status: "unknown" };
    },
  };

  /** Exactly one paid GET. Maps the seller's answer as orchestration/tools.ts callPaidApi does. */
  async function send(record: PreparedRecord): Promise<PaymentSubmission> {
    let res: Response;
    try {
      res = await fetchSeller(record.url, { [X402_HEADERS.paymentSignature]: record.header });
    } catch (e) {
      const error = `paid request failed before a response: ${describeError(e)}`;
      log(`[adapter:overflow-facilitator] ${record.purchaseId}: ${error}; outcome unknown, reconcile nonce ${record.nonce}`);
      return { outcome: "unknown", error };
    }
    const text = await res.text().catch(() => "");
    if (res.status === 402) {
      let body: z.infer<typeof BlockedBody> | undefined;
      try {
        const parsed = BlockedBody.safeParse(JSON.parse(text || "{}"));
        body = parsed.success ? parsed.data : undefined;
      } catch {
        body = undefined;
      }
      if (body && body.error !== "payment_blocked") {
        // A second 402 with a new quote is not a revert; the authorization was not consumed and must not be re-signed here.
        return { outcome: "unknown", error: `seller answered 402 ${body.error} to the paid request; reconcile before anything else` };
      }
      const decoded = body?.decoded?.name ? `${body.decoded.name}(${(body.decoded.args ?? []).join(",")})` : "payment_blocked";
      const reason = body?.decoded?.reason;
      const tx = body?.txHash && TxHash.safeParse(body.txHash).success ? body.txHash : undefined;
      log(`[adapter:overflow-facilitator] ${record.purchaseId}: treasury refused ${decoded}${reason ? ` (${reason})` : ""}${tx ? ` [reverted onchain ${tx}]` : " [simulation]"}`);
      return { outcome: "rejected", decodedRevert: decoded };
    }
    if (res.status === 502) {
      const error = `seller reported payment outcome unknown: ${text.slice(0, 300)}`;
      log(`[adapter:overflow-facilitator] ${record.purchaseId}: ${error}`);
      return { outcome: "unknown", error };
    }
    if (!res.ok) {
      return { outcome: "unknown", error: `seller answered HTTP ${res.status} to the paid request: ${text.slice(0, 300)}` };
    }
    let settlement;
    try {
      settlement = parsePaymentResponse(res);
    } catch (e) {
      return { outcome: "unknown", error: `200 without a valid PAYMENT-RESPONSE: ${describeError(e)}` };
    }
    const txHash = settlement?.transaction;
    if (!txHash || !TxHash.safeParse(txHash).success) {
      return { outcome: "unknown", error: "200 without a settlement transaction in PAYMENT-RESPONSE" };
    }
    log(`[adapter:overflow-facilitator] ${record.purchaseId}: seller confirmed settle() tx ${txHash}; funding is the indexer's call`);
    return { outcome: "submitted", txHash: txHash as Hex };
  }
}

// ---------------------------------------------------------------------------
// viem-backed chain reads (nodeOfKey, authorizationState, Paid log scan).
// ---------------------------------------------------------------------------

const USDC_AUTH_STATE_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** The subset of viem's PublicClient these reads use; structural so any viem copy type-checks. */
export interface AdapterPublicClient {
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  getLogs(args: {
    address: Address;
    event: unknown;
    fromBlock?: bigint | "earliest";
    toBlock?: bigint | "latest";
  }): Promise<ReadonlyArray<{ transactionHash: Hex | null; args?: unknown }>>;
}

export interface ViemAdapterChainOptions {
  treasury: Address;
  usdc?: Address | undefined;
  /** Where Paid log scans start (the treasury's deployment block); default scans from the earliest block. */
  fromBlock?: bigint | undefined;
}

export function viemAdapterChain(client: AdapterPublicClient, o: ViemAdapterChainOptions): AdapterChainReads & NodeOfKeyReader {
  const usdc = o.usdc ?? USDC.address;
  const paidEvent = overflowTreasuryAbi.find((e) => e.type === "event" && e.name === "Paid");
  return {
    async nodeOfKey(key) {
      return BigInt(String(await client.readContract({ address: o.treasury, abi: overflowTreasuryAbi, functionName: "nodeOfKey", args: [key] })));
    },
    async authorizationState(authorizer, nonce) {
      return Boolean(await client.readContract({ address: usdc, abi: USDC_AUTH_STATE_ABI, functionName: "authorizationState", args: [authorizer, nonce] }));
    },
    async findPaidTx(nonce) {
      if (!paidEvent) return null;
      const logs = await client.getLogs({ address: o.treasury, event: paidEvent, fromBlock: o.fromBlock ?? "earliest", toBlock: "latest" });
      for (const l of logs) {
        const args = l.args as { nonce?: Hex } | undefined;
        if (args?.nonce?.toLowerCase() === nonce.toLowerCase() && l.transactionHash) return l.transactionHash;
      }
      return null;
    },
  };
}
