/**
 * SIMULATED fixtures for the overflow-mcp tests: a throwaway node key, made-up addresses, a fake seller, a fake
 * facilitator and a fake treasury. Nothing here touches a network or holds funds.
 */
import { encodeBase64Json, X402_HEADERS, X402_NETWORK_BASE_SEPOLIA, type FetchLike, type TransferTypedData } from "@overflow/payment-client";
import { USDC, type Address } from "@overflow/schemas";
import { getAddress, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { vi } from "vitest";
import type { ChainReader, TreasuryNode } from "./chain";

export const NODE_ACCOUNT = privateKeyToAccount(keccak256(toHex("overflow.simulated.overflow-mcp-test-node"))); // SIMULATED, never funded
export const TREASURY = getAddress("0x1111111111111111111111111111111111111111");
export const SEARCH_PAYEE = getAddress("0x2222222222222222222222222222222222222222");
export const ATTACKER = getAddress("0x3333333333333333333333333333333333333333"); // SIMULATED attacker payee, never allowlisted
export const SERVICE_URL = "http://service.test";
export const SELLER_URL = "http://seller.test";
export const SEARCH_URL = `${SELLER_URL}/api/search?q=ev`;
export const PREMIUM_URL = `${SELLER_URL}/premium-intel`;
export const TX = `0x${"ab".repeat(32)}`;
export const NOW = 1_800_000_000;
export const USDC_6 = 1_000_000n;

/** A NodeSigner whose signTypedData is a spy over the real account. */
export function spySigner() {
  return {
    address: NODE_ACCOUNT.address,
    signTypedData: vi.fn((td: TransferTypedData) => NODE_ACCOUNT.signTypedData(td)),
  };
}

export function node(partial: Partial<TreasuryNode> & { key?: Address } = {}): TreasuryNode {
  return {
    key: NODE_ACCOUNT.address,
    parent: 0n,
    depth: 0n,
    cap: 50n * USDC_6,
    spent: 10n * USDC_6,
    maxPerCall: 15n * USDC_6,
    expiry: BigInt(NOW + 7 * 86400),
    paused: false,
    restricted: false,
    ...partial,
  };
}

export interface FakeChainState {
  nodes: Record<string, TreasuryNode>;
  keys: Record<string, bigint>;
  allowlist: Address[];
  nodeAllow?: Record<string, Address[]>;
}

export function fakeChain(state: FakeChainState): ChainReader {
  const lower = (a: string) => a.toLowerCase();
  return {
    nodeOfKey: async (key) => state.keys[lower(key)] ?? 0n,
    getNode: async (id) => {
      const n = state.nodes[id.toString()];
      if (!n) throw new Error(`fake chain: no node ${id}`);
      return n;
    },
    remaining: async (id) => {
      let r: bigint | null = null;
      let n = id;
      while (n !== 0n) {
        const node = state.nodes[n.toString()];
        if (!node) return 0n;
        const left = node.cap > node.spent ? node.cap - node.spent : 0n;
        if (r === null || left < r) r = left;
        n = node.parent;
      }
      return r ?? 0n;
    },
    allowlist: async (payee) => state.allowlist.some((a) => lower(a) === lower(payee)),
    nodeAllow: async (id, payee) => (state.nodeAllow?.[id.toString()] ?? []).some((a) => lower(a) === lower(payee)),
  };
}

/** Root node 1 keyed by the test signer, search payee allowlisted, attacker not. */
export function defaultChain(overrides: Partial<FakeChainState> = {}): ChainReader {
  return fakeChain({
    nodes: { "1": node() },
    keys: { [NODE_ACCOUNT.address.toLowerCase()]: 1n },
    allowlist: [SEARCH_PAYEE],
    ...overrides,
  });
}

export function requirementFor(payTo: Address, amount: string) {
  return { scheme: "exact", network: X402_NETWORK_BASE_SEPOLIA, asset: USDC.address, payTo, amount, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" } };
}

export function paymentRequired(url: string, payTo: Address, amount: string) {
  return { x402Version: 2, resource: { url }, accepts: [requirementFor(payTo, amount)] };
}

export function response402(url: string, payTo: Address, amount: string, opts: { header?: boolean; body?: boolean; extra?: Record<string, unknown> } = {}): Response {
  const pr = paymentRequired(url, payTo, amount);
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.header ?? true) headers.set(X402_HEADERS.paymentRequired, encodeBase64Json(pr));
  const body = (opts.body ?? true) ? JSON.stringify({ ...pr, simulated: true, ...(opts.extra ?? {}) }) : null;
  return new Response(body, { status: 402, headers });
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function paidResponse(body: Record<string, unknown>, amount: string): Response {
  const settlement = { success: true, transaction: TX, network: X402_NETWORK_BASE_SEPOLIA, payer: NODE_ACCOUNT.address, amount };
  return json(200, { ...body, settlement: { txHash: TX, blockNumber: "1", nodeId: "1", payer: NODE_ACCOUNT.address }, simulated: true }, { [X402_HEADERS.paymentResponse]: encodeBase64Json(settlement) });
}

export function sigHeader(init?: RequestInit): string | null {
  return new Headers(init?.headers).get(X402_HEADERS.paymentSignature);
}

export interface Call {
  url: string;
  init: RequestInit | undefined;
  method: string;
  paymentSignature: string | null;
}

export type Route = (call: Call) => Response | Promise<Response> | null | undefined;

/** Records every request; the first route returning a Response answers. */
export class FakeFetch {
  readonly calls: Call[] = [];
  readonly verifyBodies: Array<Record<string, unknown>> = [];
  constructor(private readonly routes: Route[]) {}

  readonly fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: Call = { url, init, method: init?.method ?? "GET", paymentSignature: sigHeader(init) };
    this.calls.push(call);
    if (url === `${SERVICE_URL}/verify` && typeof init?.body === "string") this.verifyBodies.push(JSON.parse(init.body) as Record<string, unknown>);
    for (const route of this.routes) {
      const r = await route(call);
      if (r) return r;
    }
    throw new Error(`fake fetch: no route for ${call.method} ${url}`);
  };

  sellerCalls(): Call[] {
    return this.calls.filter((c) => c.url.startsWith(SELLER_URL));
  }
  verifyCalls(): Call[] {
    return this.calls.filter((c) => c.url === `${SERVICE_URL}/verify`);
  }
}

/** The facilitator's /verify: PayeeNotAllowed(0) for the attacker, valid for everyone else. */
export const verifyRoute: Route = ({ url, init }) => {
  if (url !== `${SERVICE_URL}/verify`) return null;
  const body = JSON.parse(String(init?.body)) as { paymentRequirements: { payTo: string }; paymentPayload: { payload: { authorization: { to: string } } } };
  const payTo = body.paymentRequirements.payTo;
  if (payTo.toLowerCase() === ATTACKER.toLowerCase()) {
    return json(200, {
      isValid: false,
      invalidReason: "Recipient is not approved for anyone",
      decoded: { name: "PayeeNotAllowed", args: ["0"], reason: "Recipient is not approved for anyone", source: "treasury", selector: "0x12345678" },
      payer: NODE_ACCOUNT.address,
    });
  }
  return json(200, { isValid: true, payer: NODE_ACCOUNT.address, nodeId: "1", digest: `0x${"cd".repeat(32)}` });
};

export const healthRoute: Route = ({ url }) =>
  url === `${SERVICE_URL}/health` ? json(200, { ok: true, chainId: 84532, treasury: TREASURY, usdc: USDC.address, escrowFactory: null, relayer: SEARCH_PAYEE }) : null;

/** SIMULATED sellers: /api/search pays the search payee, /premium-intel the attacker. */
export function sellerRoutes(opts: { paidSearch?: (call: Call) => Response } = {}): Route[] {
  return [
    ({ url, paymentSignature }) => {
      if (!url.startsWith(`${SELLER_URL}/api/search`)) return null;
      if (!paymentSignature) return response402(url, SEARCH_PAYEE, "20000");
      return opts.paidSearch ? opts.paidSearch({ url, init: undefined, method: "GET", paymentSignature }) : paidResponse({ results: [{ title: "EV registrations 2026 (SIMULATED)" }] }, "20000");
    },
    ({ url, paymentSignature }) => {
      if (url !== PREMIUM_URL) return null;
      if (!paymentSignature) return response402(url, ATTACKER, "50000");
      // The seller's own settle attempt: the treasury reverts PayeeNotAllowed(0).
      return response402(url, ATTACKER, "50000", { extra: { error: "payment_blocked", decoded: { name: "PayeeNotAllowed", args: ["0"], decoded: "PayeeNotAllowed(0)", reason: "Recipient is not approved for anyone" } } });
    },
  ];
}
