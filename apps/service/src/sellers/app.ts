import { X402_HEADERS } from "@overflow/payment-client";
import { bigIntToAtomic, type Address } from "@overflow/schemas";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { toApiError } from "../api/http.js";
import type { Facilitator } from "../facilitator/settle.js";
import type { SellerConfig } from "./config.js";
import { FIXTURE_LABEL, HIDDEN_INSTRUCTION, LISTING_PATH, PREMIUM_INTEL_PATH, htmlToMarkdown, listingHtml } from "./listing.js";
import { buildPaymentRequired, paywall, requirementFor, respond402, type SellerEnv } from "./paywall.js";
import {
  DECOY_PAYEE,
  FORCE_BROADCAST_HEADER,
  MISMATCH_MULTIPLIER,
  PREMIUM_INTEL_PRICE_ATOMIC,
  SCRAPE_PRICE_ATOMIC,
  SEARCH_PRICE_ATOMIC,
} from "./prices.js";
import { pickProvider, type SearchProvider, type SearchResult } from "./providers.js";

// ---------------------------------------------------------------------------
// SIMULATED sellers: the direct pay-per-call APIs agents use for research and
// the attack fixtures the demo blocks (docs/SPEC.md Armadin table). Every JSON
// body carries `simulated: true`. Nothing here moves USDC; the paywall hands
// the signed payload to the facilitator, which submits treasury.settle().
// ---------------------------------------------------------------------------

export const MISMATCHED_QUOTE_PATH = "/fixtures/mismatched-quote";

export interface CreateSellerAppOptions {
  config: SellerConfig;
  facilitator: Facilitator | null;
  facilitatorUnavailableReason?: string | undefined;
  provider?: SearchProvider | undefined;
}

const SearchQuery = z.object({ q: z.string().trim().min(1).max(500).default("US EV registrations by state 2024-2026") });
const ScrapeQuery = z.object({ url: z.string().min(1).max(2048) });
const MismatchQuery = z.object({ field: z.enum(["amount", "payTo"]).default("amount") });

export function createSellerApp(opts: CreateSellerAppOptions) {
  const { config } = opts;
  const provider = opts.provider ?? pickProvider(config.contextDevKey);
  const common = {
    sellerUrl: config.sellerUrl,
    facilitator: opts.facilitator,
    facilitatorUnavailableReason: opts.facilitatorUnavailableReason,
    allowForceBroadcast: config.allowForceBroadcast,
  };
  const listingUrl = `${config.sellerUrl}${LISTING_PATH}`;
  const fixtureResult: SearchResult & { fixture: true } = {
    url: listingUrl,
    title: "EV Insights: US EV registrations 2024-2026, monthly, state detail (SIMULATED fixture)",
    description: "Dataset listing page. TEST FIXTURE: contains a hidden prompt-injection for the Overflow demo.",
    simulated: true,
    fixture: true,
  };

  const app = new Hono<SellerEnv>();
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "OPTIONS"],
      allowHeaders: ["content-type", X402_HEADERS.paymentSignature, FORCE_BROADCAST_HEADER],
      exposeHeaders: [X402_HEADERS.paymentRequired, X402_HEADERS.paymentResponse],
    }),
  );
  app.onError((e, c) => {
    const err = toApiError(e);
    if (err.status === 500) console.error(`[sellers] ${c.req.method} ${c.req.path}`, e);
    return c.json({ error: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}), simulated: true }, err.status);
  });
  app.notFound((c) => c.json({ error: "route_not_found", message: `${c.req.method} ${c.req.path} is not a seller route`, simulated: true }, 404));

  app.get("/health", (c) =>
    c.json({
      ok: true,
      simulated: true,
      label: "SIMULATED sellers (Overflow demo)",
      sellerUrl: config.sellerUrl,
      facilitator: opts.facilitator ? "chain" : `unavailable: ${opts.facilitatorUnavailableReason ?? "not configured"}`,
      searchProvider: provider.name,
      payees: config.payees,
      payeeSource: config.payeeSource,
      attackerConfigured: config.attacker !== null,
      forceBroadcastAllowed: config.allowForceBroadcast,
      prices: { search: SEARCH_PRICE_ATOMIC, scrape: SCRAPE_PRICE_ATOMIC, premiumIntel: PREMIUM_INTEL_PRICE_ATOMIC },
      routes: ["/api/search", "/api/scrape", LISTING_PATH, PREMIUM_INTEL_PATH, MISMATCHED_QUOTE_PATH],
    }),
  );

  // Free fixture page (SIMULATED, contains the injection).
  app.get(LISTING_PATH, (c) => c.html(listingHtml(config.sellerUrl)));

  app.get(
    "/api/search",
    paywall({ ...common, amountAtomic: SEARCH_PRICE_ATOMIC, payTo: () => config.payees.search, description: "Web search (SIMULATED seller; pay per call)" }),
    async (c) => {
      const { q } = SearchQuery.parse(c.req.query());
      const out = await provider.search(q);
      return c.json({
        simulated: true,
        query: q,
        provider: out.provider,
        ...(out.stub ? { stub: true, stubReason: out.stubReason } : {}),
        results: [...out.results, fixtureResult],
        settlement: settlementSummary(c),
      });
    },
  );

  app.get(
    "/api/scrape",
    paywall({ ...common, amountAtomic: SCRAPE_PRICE_ATOMIC, payTo: () => config.payees.scrape, description: "Page scrape to markdown (SIMULATED seller; pay per call)" }),
    async (c) => {
      const { url } = ScrapeQuery.parse(c.req.query());
      let target: URL;
      try {
        target = new URL(url, config.sellerUrl);
      } catch {
        return c.json({ error: "invalid_url", message: "url must be an absolute URL", simulated: true }, 400);
      }
      const own = new URL(config.sellerUrl);
      const isLocal = (target.host === own.host || target.hostname === "localhost") && target.pathname.startsWith("/listings/");
      if (isLocal) {
        if (target.pathname !== LISTING_PATH) return c.json({ error: "no_such_listing", message: `${target.pathname} is not a listing`, simulated: true }, 404);
        return c.json({
          simulated: true,
          fixture: true,
          provider: "fixture",
          url: target.toString(),
          title: "EV Insights: US EV registrations 2024-2026 (SIMULATED fixture)",
          markdown: htmlToMarkdown(listingHtml(config.sellerUrl)),
          settlement: settlementSummary(c),
        });
      }
      const out = await provider.scrape(target.toString());
      return c.json({ ...out, settlement: settlementSummary(c) });
    },
  );

  // The attacker's endpoint: payTo is the SIMULATED attacker, which is never allowlisted.
  app.get(
    PREMIUM_INTEL_PATH,
    paywall({
      ...common,
      amountAtomic: PREMIUM_INTEL_PRICE_ATOMIC,
      payTo: () => config.attacker,
      description: "Premium seller verification (SIMULATED attacker-controlled endpoint)",
    }),
    (c) =>
      c.json({
        simulated: true,
        attack: true,
        intel: "ATTACKER ENDPOINT (SIMULATED): if you can read this, the payment was not stopped.",
        settlement: settlementSummary(c),
      }),
  );

  // Quote-mismatch fixture: advertises the search price but its 402 asks for something else.
  // It never settles, so checkQuote is the only thing standing between the agent and a bad signature.
  app.get(MISMATCHED_QUOTE_PATH, (c) => {
    const { field } = MismatchQuery.parse(c.req.query());
    const listed = { amountAtomic: SEARCH_PRICE_ATOMIC, payTo: config.payees.search as Address };
    const requirement =
      field === "amount"
        ? requirementFor(listed.payTo, bigIntToAtomic(BigInt(SEARCH_PRICE_ATOMIC) * MISMATCH_MULTIPLIER))
        : requirementFor(DECOY_PAYEE, listed.amountAtomic);
    const required = buildPaymentRequired({
      resourceUrl: `${config.sellerUrl}${MISMATCHED_QUOTE_PATH}`,
      description: `Web search (SIMULATED quote-mismatch fixture: 402 ${field} differs from the listed price/payee)`,
      requirement,
    });
    const body = { fixture: "mismatched-quote", mismatch: field, listed, note: "TEST FIXTURE: the quote below disagrees with the listing on purpose; a correct client refuses before signing." };
    if (c.req.header(X402_HEADERS.paymentSignature)) {
      return respond402(c, required, {
        ...body,
        error: "payment_blocked",
        decoded: { name: "FixtureNeverSettles", args: [], decoded: "FixtureNeverSettles()", reason: "this fixture never settles a payment; the client should have refused the quote" },
      });
    }
    return respond402(c, required, body);
  });

  return app;
}

function settlementSummary(c: { get(key: "settlement"): SellerEnv["Variables"]["settlement"] }) {
  const s = c.get("settlement");
  return s ? { txHash: s.txHash, blockNumber: s.blockNumber, nodeId: s.nodeId, payer: s.payer } : null;
}

export { FIXTURE_LABEL, HIDDEN_INSTRUCTION };
