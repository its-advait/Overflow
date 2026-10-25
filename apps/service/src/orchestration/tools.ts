import type Anthropic from "@anthropic-ai/sdk";
import { createRepositories, type Db } from "@overflow/database";
import { loadCatalog } from "@overflow/datasets";
import {
  parsePaymentResponse,
  PaymentOutcomeUnknownError,
  QuoteMismatchError,
  SigningRefusedError,
  wrapFetch,
  type FetchLike,
} from "@overflow/payment-client";
import { AddressSchema, AtomicAmountSchema, formatUsdc, ResourceRequestSchema, type Address } from "@overflow/schemas";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";
import type { ActivityBus } from "../chain/bus.js";
import { directApiOrder } from "../sellers/direct-order.js";
import { htmlToMarkdown } from "../sellers/listing.js";
import { FORCE_BROADCAST_HEADER } from "../sellers/prices.js";
import { defaultCatalogPath } from "../sellers/recourse/datasets.js";

// ---------------------------------------------------------------------------------------------------
// The six agent tools. None sends funds: propose_purchase writes a resource request for Oracle + Fusion;
// call_paid_api signs an x402 authorization that only OverflowTreasury.settle() can turn into a payment,
// after its policy checks. Every call and result is an activity event carrying the agent id (agent-loop.ts).
// ---------------------------------------------------------------------------------------------------

export const MAX_RESULT_CHARS = 4000;

export function clip(value: unknown, max = MAX_RESULT_CHARS): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

const ListResourcesInput = z.object({ query: z.string().max(200).optional() });
const RequestSampleInput = z.object({ resourceId: z.string().min(1), rows: z.number().int().min(1).max(20).default(5) });
const ProposePurchaseInput = ResourceRequestSchema.extend({
  resourceId: z.string().min(1).optional(),
  reason: z.string().min(1).max(1000),
});
const CallPaidApiInput = z.object({
  endpoint: z.enum(["search", "scrape", "premium-intel", "url"]),
  query: z.string().max(500).optional(),
  url: z.string().max(2000).optional(),
});
const FetchPageInput = z.object({ url: z.string().min(1).max(2000) });
const ReportFindingsInput = z.object({
  summary: z.string().min(1).max(4000),
  findings: z.array(z.string().min(1).max(1000)).max(20).default([]),
});

export const TOOL_INPUT_SCHEMAS = {
  list_resources: ListResourcesInput,
  request_sample: RequestSampleInput,
  propose_purchase: ProposePurchaseInput,
  call_paid_api: CallPaidApiInput,
  fetch_page: FetchPageInput,
  report_findings: ReportFindingsInput,
} as const;
export type ToolName = keyof typeof TOOL_INPUT_SCHEMAS;
export const TOOL_NAMES = Object.keys(TOOL_INPUT_SCHEMAS) as ToolName[];

const obj = (properties: Record<string, unknown>, required: string[] = []): Anthropic.Tool.InputSchema => ({ type: "object", properties, required });

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_resources",
    description: "List the SIMULATED data listings in the marketplace catalog (id, title, coverage, price in atomic USDC, license, seats). Free.",
    input_schema: obj({ query: { type: "string", description: "Optional keyword filter on title/coverage." } }),
  },
  {
    name: "request_sample",
    description: "Read the first rows of a listing's SIMULATED dataset to judge fit before proposing a purchase. Free.",
    input_schema: obj({ resourceId: { type: "string" }, rows: { type: "integer", minimum: 1, maximum: 20 } }, ["resourceId"]),
  },
  {
    name: "propose_purchase",
    description:
      "Propose buying a dataset by filing a structured resource request for the Oracle and Fusion. This NEVER pays: the Oracle recommends, Fusion merges compatible requests, the treasury's policy decides.",
    input_schema: obj(
      {
        resourceId: { type: "string", description: "Catalog listing id you have in mind, if any." },
        topic: { type: "string" },
        regions: { type: "array", items: { type: "string" }, description: "Region codes, e.g. US, US-CA." },
        dateRange: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } }, required: ["start", "end"] },
        granularity: { type: "string", description: "monthly | quarterly | annual | daily as the listing uses it." },
        requiredFields: { type: "array", items: { type: "string" } },
        format: { type: "array", items: { type: "string" }, description: "Formats you can read, e.g. csv." },
        license: { type: "string", description: "e.g. company-use" },
        freshness: { type: "object", description: "Freshness requirement, e.g. {\"maxAgeDays\": 90}." },
        maxPriceAtomic: { type: "string", description: "Integer atomic USDC (6 decimals) as a decimal string." },
        reason: { type: "string" },
      },
      ["topic", "regions", "dateRange", "granularity", "requiredFields", "format", "license", "freshness", "maxPriceAtomic", "reason"],
    ),
  },
  {
    name: "call_paid_api",
    description:
      "Call a pay-per-call x402 API of the SIMULATED seller: search (0.02 USDC, query), scrape (0.05 USDC, url), premium-intel (0.05 USDC), or a url under the seller. Your node key signs a treasury authorization; the treasury's policy (cap, per-call limit, allowed payees) decides whether it pays.",
    input_schema: obj({ endpoint: { type: "string", enum: ["search", "scrape", "premium-intel", "url"] }, query: { type: "string" }, url: { type: "string" } }, ["endpoint"]),
  },
  {
    name: "fetch_page",
    description: "Fetch a free page from the SIMULATED seller (listing pages) as markdown.",
    input_schema: obj({ url: { type: "string" } }, ["url"]),
  },
  {
    name: "report_findings",
    description: "Finish: hand your summary and findings to the orchestrator. Call this exactly once when you are done.",
    input_schema: obj({ summary: { type: "string" }, findings: { type: "array", items: { type: "string" } } }, ["summary"]),
  },
];

export interface ToolContext {
  db: Db;
  bus: ActivityBus;
  agentId: string;
  missionId: string;
  nodeId: bigint;
  account: PrivateKeyAccount;
  treasury: Address;
  sellerUrl: string;
  /** DEMO_MODE: ask the seller to broadcast a settle() the simulation says will revert, so the revert is onchain. */
  forceBroadcast: boolean;
  /** Set only by the labeled SIMULATED injection probe. */
  simulated?: boolean;
  fetchImpl?: FetchLike;
  catalogPath?: string;
  nowSeconds?: () => number;
}

export interface ToolResult {
  content: string;
  isError: boolean;
  /** Payment facts the loop surfaces to the mission summary. */
  payment?: { outcome: "paid" | "blocked" | "unknown" | "refused"; decoded?: string; txHash?: `0x${string}`; url: string; amountAtomic?: string };
}

export class ToolDone {
  constructor(public readonly summary: string, public readonly findings: string[]) {}
}

function sellerPath(ctx: ToolContext, raw: string): URL {
  const base = new URL(ctx.sellerUrl);
  const url = new URL(raw, base);
  if (url.origin !== base.origin) throw new Error(`refusing ${url.origin}: tools may only reach the SIMULATED seller at ${base.origin}`);
  return url;
}

async function emit(ctx: ToolContext, e: Omit<Parameters<ReturnType<typeof createRepositories>["activityEvents"]["insert"]>[0], "agentId" | "missionId">) {
  const ev = await createRepositories(ctx.db).activityEvents.insert({ ...e, agentId: ctx.agentId, missionId: ctx.missionId, ...(ctx.simulated ? { simulated: true } : {}) });
  ctx.bus.publish(ev);
  return ev;
}

const BlockedBody = z.object({
  error: z.string(),
  decoded: z.object({ name: z.string(), args: z.array(z.string()).default([]), reason: z.string().optional() }).partial().optional(),
  txHash: z.string().optional(),
  digest: z.string().optional(),
});

async function callPaidApi(input: z.infer<typeof CallPaidApiInput>, ctx: ToolContext): Promise<ToolResult> {
  const target =
    input.endpoint === "search"
      ? sellerPath(ctx, `/api/search?q=${encodeURIComponent(input.query ?? "")}`)
      : input.endpoint === "scrape"
        ? sellerPath(ctx, `/api/scrape?url=${encodeURIComponent(input.url ?? "")}`)
        : input.endpoint === "premium-intel"
          ? sellerPath(ctx, "/premium-intel")
          : sellerPath(ctx, input.url ?? "");
  const url = target.toString();
  let amountAtomic: string | undefined;
  const paid = wrapFetch(ctx.fetchImpl ?? fetch, {
    nodeAccount: ctx.account,
    treasury: ctx.treasury,
    ...(ctx.nowSeconds ? { now: ctx.nowSeconds } : {}),
    adapter: {
      // Direct pay-per-call API: the seller's quote names the payee; the treasury's policy, not this client,
      // decides whether that payee may be paid (PayeeNotAllowed otherwise). That is the demo's point.
      resolveOrder: async ({ requirements }) => {
        amountAtomic = AtomicAmountSchema.parse(requirements.amount);
        return directApiOrder({ resourceUrl: url, payTo: AddressSchema.parse(requirements.payTo), amountAtomic, treasury: ctx.treasury, nodeId: Number(ctx.nodeId), missionId: ctx.missionId, ...(ctx.nowSeconds ? { nowSeconds: ctx.nowSeconds() } : {}) });
      },
      approvedDirectSellers: (order) => [order.sellerAddress],
      onAuthorized: async ({ signed, quote }) => {
        await emit(ctx, { kind: "payment.authorized", message: `${ctx.agentId} signed authorization ${signed.digest} for ${formatUsdc(quote.value)} USDC to ${quote.payTo} (${url}); the treasury decides` });
      },
    },
  });
  const headers: Record<string, string> = ctx.forceBroadcast ? { [FORCE_BROADCAST_HEADER]: "1" } : {};
  let res: Response;
  try {
    res = await paid(url, { headers });
  } catch (err) {
    if (err instanceof PaymentOutcomeUnknownError) {
      await emit(ctx, { kind: "purchase.status", message: `payment outcome unknown for ${url} (digest ${err.digest}); reconcile before any retry, never re-sign` });
      return { content: `Payment outcome unknown (digest ${err.digest}). Do not retry; the chain decides.`, isError: true, payment: { outcome: "unknown", url } };
    }
    if (err instanceof QuoteMismatchError || err instanceof SigningRefusedError) {
      await emit(ctx, { kind: "policy.blocked", message: `refused to sign for ${url}: ${err.message}`, decodedRevert: err.name });
      return { content: `Refused to sign: ${err.message}`, isError: true, payment: { outcome: "refused", url, decoded: err.name } };
    }
    throw err;
  }
  const text = await res.text();
  if (res.status === 402) {
    const body = BlockedBody.safeParse(JSON.parse(text || "{}"));
    const decoded = body.success && body.data.decoded?.name ? `${body.data.decoded.name}(${(body.data.decoded.args ?? []).join(",")})` : "payment_blocked";
    const reason = body.success ? body.data.decoded?.reason : undefined;
    const txHash = body.success && body.data.txHash && /^0x[0-9a-fA-F]{64}$/.test(body.data.txHash) ? (body.data.txHash as `0x${string}`) : undefined;
    await emit(ctx, { kind: "policy.blocked", message: `treasury refused ${formatUsdc(amountAtomic ?? "0")} USDC for ${url}: ${decoded}${reason ? ` (${reason})` : ""}${txHash ? " [reverted onchain]" : " [simulation]"}`, decodedRevert: decoded, ...(txHash ? { txHash } : {}) });
    return { content: `Payment blocked by treasury policy: ${decoded}${reason ? `. ${reason}` : ""}. This payee cannot be paid from your node.`, isError: true, payment: { outcome: "blocked", decoded, url, ...(txHash ? { txHash } : {}), ...(amountAtomic ? { amountAtomic } : {}) } };
  }
  if (res.status === 502) {
    await emit(ctx, { kind: "purchase.status", message: `seller reported payment outcome unknown for ${url}: ${clip(text, 300)}` });
    return { content: `Payment outcome unknown; do not retry. ${clip(text, 500)}`, isError: true, payment: { outcome: "unknown", url } };
  }
  if (!res.ok) return { content: `Request failed (HTTP ${res.status}): ${clip(text, 1000)}`, isError: true };
  const settlement = parsePaymentResponse(res);
  const txHash = settlement?.transaction as `0x${string}` | undefined;
  if (txHash) {
    await emit(ctx, { kind: "purchase.status", message: `paid ${formatUsdc(amountAtomic ?? "0")} USDC for ${url}; settle() tx ${txHash} (confirmed by the seller's PAYMENT-RESPONSE; the indexer books treasury.paid)`, txHash });
  }
  return { content: clip(text), isError: false, ...(txHash ? { payment: { outcome: "paid", txHash, url, ...(amountAtomic ? { amountAtomic } : {}) } } : {}) };
}

export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult | ToolDone> {
  if (!(name in TOOL_INPUT_SCHEMAS)) return { content: `Unknown tool ${name}`, isError: true };
  const schema = TOOL_INPUT_SCHEMAS[name as ToolName];
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) return { content: `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, isError: true };
  const repos = createRepositories(ctx.db);
  switch (name as ToolName) {
    case "list_resources": {
      const { query } = parsed.data as z.infer<typeof ListResourcesInput>;
      const q = query?.toLowerCase();
      const rows = (await repos.resources.list())
        .filter((r) => !q || r.title.toLowerCase().includes(q) || JSON.stringify(r.coverage).toLowerCase().includes(q))
        .map((r) => ({ id: r.id, title: r.title, coverage: r.coverage, priceAtomic: r.priceAtomic, priceUsdc: formatUsdc(r.priceAtomic), license: r.license, seats: r.seats, simulated: r.simulated }));
      return { content: clip({ simulated: true, count: rows.length, listings: rows }), isError: false };
    }
    case "request_sample": {
      const { resourceId, rows } = parsed.data as z.infer<typeof RequestSampleInput>;
      const catalog = await loadCatalog(ctx.catalogPath);
      const entry = catalog.listings.find((l) => l.id === resourceId);
      if (!entry) return { content: `No listing ${resourceId} in the catalog`, isError: true };
      // Same default as loadCatalog: <repo>/data, not the service's working directory.
      const dataDir = dirname(ctx.catalogPath ?? defaultCatalogPath());
      const csv = await readFile(resolve(dataDir, entry.dataset.rowsCsv), "utf8");
      const lines = csv.split(/\r?\n/).filter(Boolean);
      return { content: clip({ simulated: true, resourceId, rowCount: entry.dataset.rowCount, header: lines[0], sample: lines.slice(1, 1 + rows) }), isError: false };
    }
    case "propose_purchase": {
      const { resourceId, reason, ...request } = parsed.data as z.infer<typeof ProposePurchaseInput>;
      const row = await repos.resourceRequests.insert({ ...request, missionId: ctx.missionId, agentId: ctx.agentId });
      await emit(ctx, { kind: "purchase.proposed", message: `${ctx.agentId} proposed a purchase (request ${row.id}${resourceId ? `, listing ${resourceId}` : ""}, max ${formatUsdc(request.maxPriceAtomic)} USDC): ${reason}. No payment: Oracle + Fusion decide next.` });
      return { content: clip({ requestId: row.id, status: row.status, note: "Filed for the Oracle and Fusion. Nothing was paid." }), isError: false };
    }
    case "call_paid_api":
      return callPaidApi(parsed.data as z.infer<typeof CallPaidApiInput>, ctx);
    case "fetch_page": {
      const { url } = parsed.data as z.infer<typeof FetchPageInput>;
      let target: URL;
      try {
        target = sellerPath(ctx, url);
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
      const res = await (ctx.fetchImpl ?? fetch)(target.toString());
      const text = await res.text();
      if (!res.ok) return { content: `HTTP ${res.status}: ${clip(text, 500)}`, isError: true };
      const md = (res.headers.get("content-type") ?? "").includes("html") ? htmlToMarkdown(text) : text;
      return { content: clip(md), isError: false };
    }
    case "report_findings": {
      const { summary, findings } = parsed.data as z.infer<typeof ReportFindingsInput>;
      await emit(ctx, { kind: "agent.report", message: `${ctx.agentId} report: ${clip(summary, 1500)}${findings.length ? ` | findings: ${clip(findings, 1500)}` : ""}` });
      return new ToolDone(summary, findings);
    }
  }
}
