import Anthropic from "@anthropic-ai/sdk";
import { createDatabase, createRepositories } from "@overflow/database";
import { loadCatalog } from "@overflow/datasets";
import { ResourceRequestSchema } from "@overflow/schemas";
import { describe, expect, it } from "vitest";
import { extractRequirements, oracleModelFromEnv } from "./extract";
import { recommend } from "./recommend";

// ---------------------------------------------------------------------------
// Live extraction against the Anthropic API. Skipped unless ANTHROPIC_API_KEY
// and CLAUDE_MODEL are set (.env is loaded into this process only).
// ---------------------------------------------------------------------------

try {
  process.loadEnvFile?.();
} catch {
  // no .env: rely on the environment
}
const live = Boolean(process.env["ANTHROPIC_API_KEY"]) && Boolean(process.env["CLAUDE_MODEL"]);

describe.skipIf(!live)("live requirement extraction", () => {
  it("returns valid ResourceRequests for the EV mission and audits the call", { timeout: 120_000 }, async () => {
    const handle = await createDatabase({ url: "", pgliteDataDir: ":memory:" });
    await handle.migrate();
    const repos = createRepositories(handle.db);
    await repos.organizations.insert({ id: "org-live", name: "FICTIONAL Live Co", departments: ["research"], simulated: true });
    const mission = await repos.missions.insert({
      id: "mission-live",
      organizationId: "org-live",
      goal: "Buy monthly EV registration data for the whole United States with state-level detail, covering 2024 through 2026, with brand and units per row, as CSV, for use by the research team. Spend at most 15 USDC.",
      budgetAtomic: "50000000",
      rootNodeId: 1,
      status: "active",
    });
    const catalog = await loadCatalog();
    const knownRegions = [...new Set(catalog.listings.flatMap((l) => l.coverage.regions))];
    const now = new Date();

    const result = await extractRequirements(
      { mission, knownRegions, now },
      { client: new Anthropic(), model: oracleModelFromEnv(), audit: repos.activityEvents },
    );

    expect(result.requests.length).toBeGreaterThan(0);
    for (const r of result.requests) {
      expect(ResourceRequestSchema.safeParse(r).success).toBe(true);
      expect(r.regions.every((code) => knownRegions.includes(code))).toBe(true);
      expect(r.dateRange.end <= now.toISOString().slice(0, 10)).toBe(true);
    }
    const events = await repos.activityEvents.listRecent();
    expect(events.filter((e) => e.kind === "oracle.model_call").length).toBe(result.modelCalls.length);

    const rec = recommend({ request: result.requests[0]!, listings: catalog.listings, now, assumptions: result.assumptions });
    // Printed so the run can be recorded in docs/PROGRESS.md.
    console.log(JSON.stringify({ model: result.modelCalls[0]!.model, requests: result.requests, assumptions: result.assumptions, modelCalls: result.modelCalls, chosen: rec.explanation.chosen?.listingId ?? null, rejected: rec.explanation.rejected.map((x) => `${x.listingId}: ${x.reasons.map((y) => y.reason).join(",")}`) }, null, 2));
    await handle.close();
  });
});
