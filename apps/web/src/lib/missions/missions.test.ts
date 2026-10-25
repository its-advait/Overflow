import { ActivityEventSchema, MissionStatusSchema, type ActivityEvent } from "@overflow/schemas";
import { describe, expect, it } from "vitest";
import * as fx from "../mocks/fixtures";
import { parseBudgetInput } from "./budget";
import { agentProgress, outputs, recommendations, runState } from "./progress";
import { fromDraft, groupByAgent, toDraft } from "./requirements";
import { MISSION_STATUS_STYLE, canConfirm, canRun, isEditable } from "./status";

describe("budget input", () => {
  it("converts human USDC to atomic units on the string, never a float", () => {
    expect(parseBudgetInput("12.50")).toMatchObject({ ok: true, atomic: "12500000" });
    expect(parseBudgetInput(" $1,000 ")).toMatchObject({ ok: true, atomic: "1000000000" });
    expect(parseBudgetInput("0.000001")).toMatchObject({ ok: true, atomic: "1" });
  });
  it("refuses what toAtomic refuses, zero and empty, with a sentence", () => {
    expect(parseBudgetInput("1.2345678")).toMatchObject({ ok: false });
    expect(parseBudgetInput("abc")).toMatchObject({ ok: false });
    expect(parseBudgetInput("0")).toEqual({ ok: false, error: "The budget must be more than 0 USDC." });
    expect(parseBudgetInput("")).toMatchObject({ ok: false });
  });
});

describe("mission status", () => {
  it("has a style for every status the schema knows", () => {
    for (const s of MissionStatusSchema.options) expect(MISSION_STATUS_STYLE[s].label.length).toBeGreaterThan(0);
  });
  it("edit, confirm and run follow the service's gates", () => {
    const planning = { ...fx.mission, status: "planning" as const };
    const open = fx.requests.find((r) => r.status === "open")!;
    const matched = fx.requests.find((r) => r.status === "matched")!;
    expect(isEditable(planning, open)).toBe(true);
    expect(isEditable(planning, matched)).toBe(false);
    expect(isEditable(fx.mission, open)).toBe(false);
    expect(canConfirm(planning, fx.requests)).toBe(true);
    expect(canConfirm(planning, fx.requests.filter((r) => r.status !== "open"))).toBe(false);
    expect(canRun(planning)).toBe(false);
    expect(canRun({ ...fx.mission, status: "confirmed" })).toBe(true);
  });
});

describe("requirement drafts", () => {
  it("round-trips a stored request through the editable form", () => {
    const r = fx.requests[0]!;
    const parsed = fromDraft(toDraft(r));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request).toEqual({
        topic: r.topic,
        regions: r.regions,
        dateRange: r.dateRange,
        granularity: r.granularity,
        requiredFields: r.requiredFields,
        format: r.format,
        license: r.license,
        freshness: r.freshness,
        maxPriceAtomic: r.maxPriceAtomic,
      });
    }
  });
  it("names the field that fails: empty regions, inverted dates, bad price, bad freshness", () => {
    const d = toDraft(fx.requests[0]!);
    const bad = fromDraft({ ...d, regions: " , ", start: "2025-09-30", end: "2025-01-01", maxPriceUsdc: "1.2345678", maxAgeDays: "0" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.issues).sort()).toEqual(["dateRange", "freshness", "maxPriceAtomic", "regions"]);
  });
  it("groups rows per agent and leaves withdrawn rows out", () => {
    const withdrawn = { ...fx.requests[0]!, id: "req-old", status: "withdrawn" as const };
    const { groups, withdrawn: n } = groupByAgent([...fx.requests, withdrawn]);
    expect(n).toBe(1);
    expect(groups.map((g) => [g.agentId, g.requests.length])).toEqual([
      ["agent-finance", 2],
      ["agent-research", 2],
    ]);
  });
});

describe("progress, recommendations and outputs from stored events", () => {
  const ev = (over: Partial<ActivityEvent> & { kind: ActivityEvent["kind"]; message: string }): ActivityEvent =>
    ActivityEventSchema.parse({ id: `t-${over.message.length}-${over.kind}`, at: "2026-10-25T10:00:00.000Z", missionId: fx.mission.id, ...over });

  it("counts tool calls, results, errors, policy blocks and reports per agent", () => {
    const events = [
      ev({ kind: "agent.tool_call", message: "list_resources {}", agentId: "agent-research", at: "2026-10-25T10:00:01.000Z" }),
      ev({ kind: "agent.tool_result", message: "list_resources: 5 listings", agentId: "agent-research", at: "2026-10-25T10:00:02.000Z" }),
      ev({ kind: "agent.tool_result", message: "call_paid_api ERROR: Payment blocked", agentId: "agent-research", at: "2026-10-25T10:00:03.000Z" }),
      ev({ kind: "policy.blocked", message: "PayeeNotAllowed", agentId: "agent-research", decodedRevert: "PayeeNotAllowed()", at: "2026-10-25T10:00:04.000Z" }),
      ev({ kind: "agent.report", message: "agent-finance report: cheapest is the national set | findings: [\"12 USDC\",\"company-use\"]", agentId: "agent-finance", at: "2026-10-25T10:00:05.000Z" }),
    ];
    const progress = agentProgress(events);
    expect(progress.map((p) => p.agentId)).toEqual(["agent-finance", "agent-research"]);
    expect(progress[1]).toMatchObject({ toolCalls: 1, toolResults: 2, errors: 1, blocked: 1, reports: 0, lastMessage: "PayeeNotAllowed" });
    expect(progress[0]).toMatchObject({ reports: 1 });
  });

  it("reads the run state from the runner's own words", () => {
    expect(runState([])).toBe("not started");
    expect(runState([ev({ kind: "mission.run", message: "run started: budget 50.00 USDC" })])).toBe("running");
    expect(runState([ev({ kind: "mission.run", message: "run started", at: "2026-10-25T10:00:00.000Z" }), ev({ kind: "mission.run", message: "run finished: nodes", at: "2026-10-25T10:01:00.000Z" })])).toBe("finished");
    expect(runState([ev({ kind: "mission.run", message: "run failed: no key" })])).toBe("failed");
  });

  it("recommendations are the oracle/fusion events plus stored reasons, deduplicated, newest first", () => {
    const rows = recommendations(fx.activity, fx.purchases, [fx.purchaseGroup]);
    expect(rows.filter((r) => r.source === "oracle")).toHaveLength(1);
    expect(rows.filter((r) => r.source === "fusion")).toHaveLength(2);
    expect(rows.filter((r) => r.source === "stored").length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.text)).size).toBe(rows.length);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.at >= rows[i]!.at).toBe(true);
  });

  it("outputs parse agent reports and the orchestrator synthesis", () => {
    const events = [
      ev({ kind: "agent.report", message: "agent-finance report: buy the national set | findings: [\"12 USDC\",\"company-use\"]", agentId: "agent-finance" }),
      ev({ kind: "agent.report", message: "orchestrator recommendation: buy it", agentId: "agent-orchestrator", at: "2026-10-25T10:00:09.000Z" }),
      ev({ kind: "agent.tool_call", message: "noise", agentId: "agent-finance" }),
    ];
    expect(outputs(events)).toEqual([
      { agentId: "agent-finance", at: "2026-10-25T10:00:00.000Z", synthesis: false, summary: "buy the national set", findings: ["12 USDC", "company-use"] },
      { agentId: "agent-orchestrator", at: "2026-10-25T10:00:09.000Z", synthesis: true, summary: "buy it", findings: [] },
    ]);
  });
});
