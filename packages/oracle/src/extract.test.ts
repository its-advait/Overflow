import { loadCatalog } from "@overflow/datasets";
import { ResourceRequestSchema } from "@overflow/schemas";
import { describe, expect, it } from "vitest";
import {
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionError,
  clampToHorizon,
  clampToPresent,
  extractRequirements,
  lastCompleteMonthEnd,
  oracleModelFromEnv,
  type ExtractionClient,
} from "./extract";
import { recommend } from "./recommend";

// ---------------------------------------------------------------------------
// Fake model client: returns scripted outputs, records the calls. No network.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-24T16:00:00Z");
const MISSION = { id: "mission-ev", goal: "Monthly EV registrations for the US with state detail, 2024-2026, brand and units", budgetAtomic: "50000000" };
const MODEL = "fake-model-for-tests";

interface RecordedCall {
  params: Record<string, unknown>;
}

function fakeClient(outputs: Array<unknown | { text: string; stop?: string }>): { client: ExtractionClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const parse = async (params: Record<string, unknown>) => {
    calls.push({ params });
    const next = outputs.shift();
    if (next === undefined) throw new Error("fake client: no scripted output left");
    const scripted = next as { text?: string; stop?: string };
    const raw = typeof scripted.text === "string" ? scripted.text : JSON.stringify(next);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    return {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: MODEL,
      stop_reason: scripted.stop ?? "end_turn",
      stop_sequence: null,
      stop_details: null,
      content: [{ type: "text", text: raw, citations: null, parsed_output: parsed }],
      usage: { input_tokens: 1, output_tokens: 1 },
      parsed_output: parsed,
    };
  };
  return { client: { messages: { parse } } as unknown as ExtractionClient, calls };
}

function fakeAudit() {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    insert: async (input: Record<string, unknown>) => {
      events.push(input);
      return { ...input, id: `evt-${events.length}`, at: NOW.toISOString() } as never;
    },
  };
}

const GOOD_OUTPUT = {
  requests: [
    {
      topic: "EV registrations",
      regions: ["US", "US-CA", "US"],
      dateRange: { start: "2024-01-01", end: "2026-12-31" },
      granularity: "monthly",
      requiredFields: ["Brand", "units", "state "],
      format: ["csv"],
      license: "company-use",
      freshnessMaxAgeDays: 90,
      maxPriceUsdc: "15",
    },
  ],
  assumptions: ["state detail means US plus state codes"],
};

describe("date clamp", () => {
  it("lastCompleteMonthEnd is the last day of the previous month", () => {
    expect(lastCompleteMonthEnd(new Date("2026-10-24T16:00:00Z"))).toBe("2026-09-30");
    expect(lastCompleteMonthEnd(new Date("2026-03-01T00:00:00Z"))).toBe("2026-02-28");
    expect(lastCompleteMonthEnd(new Date("2026-01-15T00:00:00Z"))).toBe("2025-12-31");
  });

  it("clamps an end in the future and records the assumption; leaves past ranges alone", () => {
    const clamped = clampToPresent({ start: "2024-01-01", end: "2026-12-31" }, NOW);
    expect(clamped.dateRange).toEqual({ start: "2024-01-01", end: "2026-09-30" });
    expect(clamped.assumption).toContain("clamped to 2026-09-30");
    const untouched = clampToPresent({ start: "2021-01-01", end: "2022-12-31" }, NOW);
    expect(untouched).toEqual({ dateRange: { start: "2021-01-01", end: "2022-12-31" } });
  });
});

describe("horizon and allowed formats (the owner's constraints, enforced in code)", () => {
  it("clampToHorizon cuts both ends and says so; no horizon or a range inside it is untouched", () => {
    const cut = clampToHorizon({ start: "2023-01-01", end: "2026-12-31" }, { start: "2024-01-01", end: "2025-12-31" });
    expect(cut.dateRange).toEqual({ start: "2024-01-01", end: "2025-12-31" });
    expect(cut.assumption).toContain("clamped to the mission horizon 2024-01-01..2025-12-31");
    expect(clampToHorizon({ start: "2024-03-01", end: "2024-06-30" }, { start: "2024-01-01", end: "2025-12-31" })).toEqual({ dateRange: { start: "2024-03-01", end: "2024-06-30" } });
    expect(clampToHorizon({ start: "2023-01-01", end: "2026-12-31" }, undefined)).toEqual({ dateRange: { start: "2023-01-01", end: "2026-12-31" } });
    // Entirely outside the horizon: the horizon itself, never an inverted range.
    expect(clampToHorizon({ start: "2020-01-01", end: "2021-12-31" }, { start: "2024-01-01", end: "2025-12-31" }).dateRange).toEqual({ start: "2024-01-01", end: "2025-12-31" });
  });

  it("puts the horizon and the allowed formats in the prompt, clamps the dates and drops disallowed formats", async () => {
    const out = { ...GOOD_OUTPUT, requests: [{ ...GOOD_OUTPUT.requests[0]!, format: ["csv", "parquet", "json"] }] };
    const { client, calls } = fakeClient([out]);
    const mission = { ...MISSION, horizon: { start: "2025-01-01", end: "2025-06-30" }, allowedFormats: ["csv", "json"] as ("csv" | "json")[] };
    const result = await extractRequirements({ mission, knownRegions: ["US"], now: NOW }, { client, model: MODEL, audit: fakeAudit() });
    const prompt = JSON.stringify(calls[0]!.params["messages"]);
    expect(prompt).toContain("Data horizon: 2025-01-01 to 2025-06-30");
    expect(prompt).toContain("Allowed formats: csv, json");
    expect(result.requests[0]!.dateRange).toEqual({ start: "2025-01-01", end: "2025-06-30" });
    expect(result.requests[0]!.format).toEqual(["csv", "json"]);
    expect(result.assumptions).toEqual([
      "state detail means US plus state codes",
      expect.stringContaining("clamped to the mission horizon"),
      "format parquet dropped: the mission allows csv, json",
    ]);
  });

  it("a request in none of the allowed formats is a validation issue the model gets to fix once", async () => {
    const bad = { ...GOOD_OUTPUT, requests: [{ ...GOOD_OUTPUT.requests[0]!, format: ["parquet"] }] };
    const { client, calls } = fakeClient([bad, GOOD_OUTPUT]);
    const mission = { ...MISSION, allowedFormats: ["csv"] as "csv"[] };
    const result = await extractRequirements({ mission, knownRegions: [], now: NOW }, { client, model: MODEL, audit: fakeAudit() });
    expect(calls).toHaveLength(2);
    expect(result.modelCalls.map((c) => c.outcome)).toEqual(["invalid", "parsed"]);
    expect(result.requests[0]!.format).toEqual(["csv"]);
  });
});

describe("extractRequirements", () => {
  it("parses a valid output into ResourceRequests, converts the price with toAtomic and clamps the dates", async () => {
    const { client, calls } = fakeClient([GOOD_OUTPUT]);
    const audit = fakeAudit();
    const result = await extractRequirements({ mission: MISSION, knownRegions: ["US", "US-CA"], now: NOW }, { client, model: MODEL, audit });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.params["model"]).toBe(MODEL);
    expect(calls[0]!.params["system"]).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(calls[0]!.params["output_config"]).toBeDefined();
    expect(JSON.stringify(calls[0]!.params["messages"])).toContain("Today is 2026-10-24");
    expect(JSON.stringify(calls[0]!.params["messages"])).toContain("50.00 USDC");

    expect(result.requests).toHaveLength(1);
    const req = result.requests[0]!;
    expect(ResourceRequestSchema.safeParse(req).success).toBe(true);
    expect(req.maxPriceAtomic).toBe("15000000");
    expect(req.regions).toEqual(["US", "US-CA"]);
    expect(req.requiredFields).toEqual(["brand", "units", "state"]);
    expect(req.dateRange).toEqual({ start: "2024-01-01", end: "2026-09-30" });
    expect(req.freshness).toEqual({ maxAgeDays: 90 });
    expect(result.assumptions).toEqual([
      "state detail means US plus state codes",
      expect.stringContaining("clamped to 2026-09-30"),
    ]);

    expect(result.modelCalls).toHaveLength(1);
    expect(result.modelCalls[0]).toMatchObject({ attempt: 1, model: MODEL, outcome: "parsed" });
    expect(result.modelCalls[0]!.promptHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.modelCalls[0]!.outputHash).toMatch(/^0x[0-9a-f]{64}$/);

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ kind: "oracle.model_call", missionId: "mission-ev", simulated: false });
    expect(audit.events[0]!["message"]).toContain(`promptHash=${result.modelCalls[0]!.promptHash}`);
    expect(audit.events[0]!["message"]).toContain(`outputHash=${result.modelCalls[0]!.outputHash}`);
    expect(audit.events[0]!["message"]).toContain("outcome=parsed");
  });

  it("clamps a max price above the mission budget and says so", async () => {
    const over = { ...GOOD_OUTPUT, requests: [{ ...GOOD_OUTPUT.requests[0]!, maxPriceUsdc: "999" }] };
    const { client } = fakeClient([over]);
    const result = await extractRequirements({ mission: MISSION, knownRegions: [], now: NOW }, { client, model: MODEL, audit: fakeAudit() });
    expect(result.requests[0]!.maxPriceAtomic).toBe("50000000");
    expect(result.assumptions.some((a) => a.includes("clamped to the mission budget"))).toBe(true);
  });

  it("retries once with the validation error and audits both calls with distinct hashes", async () => {
    const bad = { ...GOOD_OUTPUT, requests: [{ ...GOOD_OUTPUT.requests[0]!, granularity: "hourly", maxPriceUsdc: "12.5" }] };
    const { client, calls } = fakeClient([{ text: JSON.stringify(bad) }, { ...GOOD_OUTPUT, requests: [{ ...GOOD_OUTPUT.requests[0]!, maxPriceUsdc: "12.5" }] }]);
    const audit = fakeAudit();
    const result = await extractRequirements({ mission: MISSION, knownRegions: ["US"], now: NOW }, { client, model: MODEL, audit });

    expect(calls).toHaveLength(2);
    const secondMessages = calls[1]!.params["messages"] as Array<{ role: string; content: string }>;
    expect(secondMessages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(secondMessages[1]!.content).toBe(JSON.stringify(bad));
    expect(secondMessages[2]!.content).toContain("failed validation");
    expect(secondMessages[2]!.content).toContain("granularity");

    expect(result.requests[0]!.maxPriceAtomic).toBe("12500000");
    expect(result.modelCalls.map((c) => c.outcome)).toEqual(["invalid", "parsed"]);
    expect(result.modelCalls[0]!.promptHash).not.toBe(result.modelCalls[1]!.promptHash);
    expect(result.modelCalls[0]!.outputHash).not.toBe(result.modelCalls[1]!.outputHash);
    expect(audit.events.map((e) => String(e["message"]).includes("outcome=invalid"))).toEqual([true, false]);
  });

  it("fails loudly after two invalid outputs, keeping both audit records", async () => {
    const { client } = fakeClient([{ text: "not json at all" }, { text: JSON.stringify({ requests: [], assumptions: [] }) }]);
    const audit = fakeAudit();
    let caught: unknown;
    try {
      await extractRequirements({ mission: MISSION, knownRegions: [], now: NOW }, { client, model: MODEL, audit });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExtractionError);
    const err = caught as ExtractionError;
    expect(err.modelCalls).toHaveLength(2);
    expect(err.issues.join(" ")).toContain("at least one request");
    expect(audit.events).toHaveLength(2);
    expect(audit.events.every((e) => String(e["message"]).includes("outcome=invalid"))).toBe(true);
  });

  it("treats a non end_turn stop as a failed attempt", async () => {
    const { client } = fakeClient([{ text: JSON.stringify(GOOD_OUTPUT), stop: "max_tokens" }, GOOD_OUTPUT]);
    const result = await extractRequirements({ mission: MISSION, knownRegions: [], now: NOW }, { client, model: MODEL, audit: fakeAudit() });
    expect(result.modelCalls.map((c) => c.outcome)).toEqual(["invalid", "parsed"]);
  });

  it("the model's preference never reaches the filter: the 2021-2022 set is rejected on dates", async () => {
    const preferring = {
      ...GOOD_OUTPUT,
      requests: [{ ...GOOD_OUTPUT.requests[0]!, regions: ["US"], maxPriceUsdc: "12.5" }],
      assumptions: ["Prefer listing-national-monthly-2021-2022: it is the cheapest and probably good enough."],
    };
    const { client } = fakeClient([preferring]);
    const extracted = await extractRequirements({ mission: MISSION, knownRegions: ["US"], now: NOW }, { client, model: MODEL, audit: fakeAudit() });
    const { listings } = await loadCatalog();
    const result = recommend({ request: extracted.requests[0]!, listings, now: NOW, assumptions: extracted.assumptions });
    expect(result.explanation.chosen?.listingId).toBe("listing-national-monthly-2024-2026");
    const stale = result.explanation.rejected.find((r) => r.listingId === "listing-national-monthly-2021-2022")!;
    expect(stale.reasons.map((r) => r.reason)).toEqual(["dateRange"]);
    expect(result.explanation.summary).toContain("Assumption: Prefer listing-national-monthly-2021-2022");
  });
});

describe("oracleModelFromEnv", () => {
  it("reads CLAUDE_MODEL and refuses to default", () => {
    expect(oracleModelFromEnv({ CLAUDE_MODEL: "some-model" })).toBe("some-model");
    expect(() => oracleModelFromEnv({})).toThrow(/CLAUDE_MODEL/);
    expect(() => oracleModelFromEnv({ CLAUDE_MODEL: "  " })).toThrow(/CLAUDE_MODEL/);
  });
});
