import { z } from "zod";

// ---------------------------------------------------------------------------
// Search / scrape providers. Canned results are SIMULATED and say so in every
// item; Context.dev runs only when CONTEXT_DEV_API_KEY is configured and falls
// back to labeled stubs on failure (Leash apps/seller/context.ts, ported).
// ---------------------------------------------------------------------------

export interface SearchResult {
  url: string;
  title: string;
  description: string;
  simulated: boolean;
}

export interface SearchOutput {
  provider: "canned" | "context.dev";
  /** Set when the real provider failed and canned results were substituted. */
  stub?: true;
  stubReason?: string;
  results: SearchResult[];
}

export interface ScrapeOutput {
  provider: "canned" | "context.dev";
  stub?: true;
  stubReason?: string;
  url: string;
  title?: string;
  markdown: string;
  simulated: boolean;
}

export interface SearchProvider {
  readonly name: "canned" | "context.dev";
  search(query: string): Promise<SearchOutput>;
  scrape(url: string): Promise<ScrapeOutput>;
}

export const CANNED_RESULTS: readonly SearchResult[] = [
  {
    url: "https://example.com/simulated/ev-registrations-national-monthly",
    title: "CANNED (SIMULATED): US EV registrations by state, monthly 2024-2026",
    description: "Synthetic registry summary used by the Overflow demo when no search provider key is configured. Not a real page.",
    simulated: true,
  },
  {
    url: "https://example.com/simulated/ev-market-brief-2026",
    title: "CANNED (SIMULATED): EV market brief, Q3 2026",
    description: "Fictional brand shares for Voltara and Kestrel, the two SIMULATED brands in the demo datasets.",
    simulated: true,
  },
  {
    url: "https://example.com/simulated/california-ev-monthly",
    title: "CANNED (SIMULATED): California EV registrations, monthly",
    description: "Points at the SIMULATED California listing in the Overflow catalog (data/catalog.json).",
    simulated: true,
  },
];

export function cannedProvider(): SearchProvider {
  return {
    name: "canned",
    async search(query) {
      return { provider: "canned", results: CANNED_RESULTS.map((r) => ({ ...r, description: `${r.description} Query: "${query}".` })) };
    },
    async scrape(url) {
      return {
        provider: "canned",
        url,
        title: "CANNED (SIMULATED) page",
        markdown: `# CANNED (SIMULATED)\n\nNo search provider key is configured, so this is a labeled stand-in for ${url}. Nothing was fetched.`,
        simulated: true,
      };
    },
  };
}

const CtxSearchSchema = z.object({
  results: z.array(z.object({ url: z.string(), title: z.string().optional(), description: z.string().optional() })).default([]),
});
const CtxScrapeSchema = z.object({
  markdown: z.object({ success: z.boolean(), data: z.string().optional(), message: z.string().optional() }).optional(),
  metadata: z.object({ title: z.string().optional() }).optional(),
});

export function contextDevProvider(apiKey: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  const BASE = "https://api.context.dev/v1";
  const canned = cannedProvider();
  async function call(path: string, body: unknown): Promise<unknown> {
    const r = await fetchImpl(`${BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    if (!r.ok) throw new Error(`Context.dev ${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  return {
    name: "context.dev",
    async search(query) {
      try {
        const j = CtxSearchSchema.parse(await call("/web/search", { query, numResults: 10 }));
        return {
          provider: "context.dev",
          results: j.results.slice(0, 5).map((r) => ({ url: r.url, title: r.title ?? "", description: (r.description ?? "").slice(0, 300), simulated: false })),
        };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(`[sellers] WARNING Context.dev search failed, returning labeled canned results: ${reason}`);
        return { ...(await canned.search(query)), provider: "context.dev", stub: true, stubReason: reason };
      }
    },
    async scrape(url) {
      try {
        const j = CtxScrapeSchema.parse(await call("/web/scrape", { url, formats: { markdown: true }, sharedParams: { mainContentOnly: true } }));
        if (!j.markdown?.success || j.markdown.data === undefined) throw new Error(j.markdown?.message ?? "markdown output failed");
        return {
          provider: "context.dev",
          url,
          ...(j.metadata?.title !== undefined ? { title: j.metadata.title } : {}),
          markdown: j.markdown.data.slice(0, 8000),
          simulated: false,
        };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(`[sellers] WARNING Context.dev scrape failed, returning labeled canned stub: ${reason}`);
        return { ...(await canned.scrape(url)), provider: "context.dev", stub: true, stubReason: reason };
      }
    },
  };
}

export function pickProvider(contextDevKey: string | null): SearchProvider {
  return contextDevKey ? contextDevProvider(contextDevKey) : cannedProvider();
}
