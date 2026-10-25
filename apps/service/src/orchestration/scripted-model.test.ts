import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ActivityEvent } from "@overflow/schemas";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PlannerClient } from "./mission-runner.js";
import {
  createScriptedModel,
  loadRecording,
  requestHash,
  ScriptedRecordingError,
  ScriptedRecordingSchema,
  ScriptedReplayError,
  stepClient,
} from "./scripted-model.js";

// SIMULATED live client: answers parse() with JSON text and create() with a scripted tool_use, like the SDK would.
function fakeLive(answers: { text?: string; tools?: Anthropic.ToolUseBlock[] }[]) {
  const queue = [...answers];
  const calls: string[] = [];
  const message = (a: { text?: string; tools?: Anthropic.ToolUseBlock[] }): Anthropic.Message =>
    ({
      id: "msg_live",
      type: "message",
      role: "assistant",
      model: "claude-test",
      stop_reason: a.tools ? "tool_use" : "end_turn",
      stop_sequence: null,
      stop_details: null,
      container: null,
      content: [...(a.text !== undefined ? [{ type: "text", text: a.text, citations: null }] : []), ...(a.tools ?? [])],
      usage: { input_tokens: 11, output_tokens: 7 },
    }) as unknown as Anthropic.Message;
  const client: PlannerClient = {
    messages: {
      async create(params) {
        calls.push(`create:${params.model}`);
        const a = queue.shift();
        if (!a) throw new Error("fake live exhausted");
        return message(a);
      },
      parse: (async (params: { output_config?: { format?: { parse?: (t: string) => unknown } } }) => {
        calls.push("parse");
        const a = queue.shift();
        if (!a) throw new Error("fake live exhausted");
        const m = message(a);
        return { ...m, parsed_output: a.text !== undefined ? params.output_config?.format?.parse?.(a.text) ?? null : null };
      }) as PlannerClient["messages"]["parse"],
    },
  };
  return { client, calls };
}

const Plan = z.object({ requests: z.array(z.object({ topic: z.string() })) });
const parseParams = (user: string) => ({ model: "claude-test", max_tokens: 100, system: "extract", messages: [{ role: "user" as const, content: user }], output_config: { format: zodOutputFormat(Plan) } });
const createParams = (user: string) => ({ model: "claude-test", max_tokens: 100, system: "You are the research sub-agent", tools: [{ name: "list_resources", description: "d", input_schema: { type: "object" as const } }], messages: [{ role: "user" as const, content: user }] });
const use = (id: string, name: string, input: unknown): Anthropic.ToolUseBlock => ({ type: "tool_use", id, name, input } as Anthropic.ToolUseBlock);

function fakeAudit() {
  const events: ActivityEvent[] = [];
  const published: ActivityEvent[] = [];
  return {
    events,
    published,
    audit: {
      async insert(input: Omit<ActivityEvent, "id" | "at" | "simulated"> & Partial<ActivityEvent>): Promise<ActivityEvent> {
        const ev: ActivityEvent = { id: `ev-${events.length + 1}`, at: new Date(0).toISOString(), simulated: false, ...input } as ActivityEvent;
        events.push(ev);
        return ev;
      },
    },
    publish: (e: ActivityEvent) => published.push(e),
  };
}

describe("scripted model: record, then replay only the model's answers", () => {
  const dir = mkdtempSync(join(tmpdir(), "overflow-scripted-"));
  const file = join(dir, "honest-seller.json");

  it("record mode calls the live client, saves each answer under its step in order, and holds one mission", async () => {
    const live = fakeLive([
      { text: JSON.stringify({ requests: [{ topic: "ev registrations" }] }) },
      { tools: [use("tu_1", "list_resources", {})] },
      { text: "done" },
      { text: JSON.stringify({ requests: [{ topic: "other mission" }] }) },
    ]);
    const logs: string[] = [];
    const scripted = createScriptedModel({ mode: "record", file, live: live.client, model: "claude-test", log: (l) => logs.push(l), now: () => new Date("2026-10-25T00:00:00Z") });
    expect(scripted.model).toBe("claude-test");

    const extract = scripted.forStep("oracle.extract", "mission-1");
    const r1 = await extract.messages.parse(parseParams("goal one"));
    expect(r1.parsed_output).toEqual({ requests: [{ topic: "ev registrations" }] });
    const agent = scripted.forStep("agent.research", "mission-1");
    const r2 = await agent.messages.create(createParams("Begin your assignment."));
    expect(r2.stop_reason).toBe("tool_use");
    await agent.messages.create(createParams("tool results"));
    // A second mission in the same process is served live but not recorded: one recording, one mission.
    await scripted.forStep("oracle.extract", "mission-2").messages.parse(parseParams("goal two"));

    expect(live.calls).toEqual(["parse", "create:claude-test", "create:claude-test", "parse"]);
    const saved = ScriptedRecordingSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    expect(saved.scripted).toBe(true);
    expect(saved.scope).toEqual({ missionId: "mission-1" });
    expect(saved.steps["oracle.extract"]?.map((c) => c.n)).toEqual([1]);
    expect(saved.steps["agent.research"]?.map((c) => [c.n, c.stopReason])).toEqual([
      [1, "tool_use"],
      [2, "end_turn"],
    ]);
    expect(saved.steps["agent.research"]?.[0]?.content).toEqual([{ type: "tool_use", id: "tu_1", name: "list_resources", input: {} }]);
    expect(saved.steps["oracle.extract"]?.[0]?.promptHash).toBe(requestHash(parseParams("goal one")));
    expect(saved.steps["oracle.extract"]?.[0]?.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(logs.some((l) => l.includes("[RECORDING] skipped oracle.extract for mission mission-2"))).toBe(true);
    expect(scripted.recording?.steps).toEqual({ "oracle.extract": 1, "agent.research": 2 });
  });

  it("replay mode never calls the API, re-runs the site's Zod parse, keeps tool_use blocks, and audits every call as SCRIPTED", async () => {
    const live = fakeLive([]); // would throw if touched
    const logs: string[] = [];
    const a = fakeAudit();
    const scripted = createScriptedModel({ mode: "replay", file, live: live.client, model: null, audit: a.audit, publish: a.publish, log: (l) => logs.push(l) });
    expect(scripted.mode).toBe("replay");
    expect(scripted.model).toBe("claude-test");
    expect(scripted.recording?.name).toBe("honest-seller");

    const r1 = await scripted.forStep("oracle.extract", "mission-9").messages.parse(parseParams("goal one"));
    expect(r1.parsed_output).toEqual({ requests: [{ topic: "ev registrations" }] });
    expect(r1.model).toBe("claude-test");
    expect(r1.id).toBe("scripted-oracle.extract-1");
    // A different prompt still replays (the answer is what is scripted), and the mismatch is said out loud.
    const agent = scripted.forStep("agent.research", "mission-9");
    const t1 = await agent.messages.create(createParams("Begin your assignment."));
    expect(t1.content).toEqual([{ type: "tool_use", id: "tu_1", name: "list_resources", input: {} }]);
    const t2 = await agent.messages.create(createParams("something the recording never saw"));
    expect(t2.stop_reason).toBe("end_turn");
    expect(live.calls).toEqual([]);

    expect(logs.filter((l) => l.startsWith("[SCRIPTED] replay"))).toHaveLength(3);
    expect(logs[0]).toContain("oracle.extract#1 from honest-seller (prompt hash matches the recording)");
    expect(logs[2]).toContain("agent.research#2 from honest-seller (prompt hash differs from the recording)");
    expect(a.events).toHaveLength(3);
    expect(a.events[0]).toMatchObject({ kind: "oracle.model_call", missionId: "mission-9" });
    expect(a.events[0]?.message).toContain("SCRIPTED replay: oracle.extract#1 from recording honest-seller");
    expect(a.events[0]?.message).toContain("no API call made");
    expect(a.published).toHaveLength(3);
  });

  it("replay cursors are per mission, and an exhausted step fails loudly instead of inventing an answer", async () => {
    const scripted = createScriptedModel({ mode: "replay", file, live: null, model: null });
    const first = scripted.forStep("agent.research", "mission-a");
    await first.messages.create(createParams("x"));
    await first.messages.create(createParams("x"));
    await expect(first.messages.create(createParams("x"))).rejects.toBeInstanceOf(ScriptedReplayError);
    // Another mission starts over.
    const again = await scripted.forStep("agent.research", "mission-b").messages.create(createParams("x"));
    expect(again.id).toBe("scripted-agent.research-1");
    // A step the recording never saw.
    await expect(scripted.forStep("sample.judge", "mission-b").messages.parse(parseParams("x"))).rejects.toThrow(/has no sample.judge calls/);
  });

  it("replay parse applies the call site's schema: a recorded answer that no longer fits fails the parse, not silently", async () => {
    const scripted = createScriptedModel({ mode: "replay", file, live: null, model: null });
    const Strict = z.object({ requests: z.array(z.object({ topic: z.string(), regions: z.array(z.string()) })) });
    await expect(
      scripted.forStep("oracle.extract", "mission-c").messages.parse({ ...parseParams("x"), output_config: { format: zodOutputFormat(Strict) } }),
    ).rejects.toThrow(/Failed to parse structured output/);
  });

  it("a missing or malformed recording is refused with its reason", () => {
    expect(() => loadRecording(join(dir, "nope.json"))).toThrow(ScriptedRecordingError);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ version: 1, scripted: true, name: "bad", recordedAt: "x", model: "m", scope: null, steps: { "oracle.extract": [{ n: 1, promptHash: "0x12", stopReason: "end_turn", content: [], recordedAt: "x" }] } }));
    expect(() => loadRecording(bad)).toThrow(/failed validation/);
    expect(() => createScriptedModel({ mode: "replay", file: bad, live: null, model: null })).toThrow(ScriptedRecordingError);
    expect(() => createScriptedModel({ mode: "record", file, live: null, model: "m" })).toThrow(/needs ANTHROPIC_API_KEY and CLAUDE_MODEL/);
  });

  it("stepClient hands the live client through when nothing is scripted", () => {
    const live = fakeLive([]);
    expect(stepClient({ client: live.client }, "oracle.extract", "m")).toBe(live.client);
    const off = createScriptedModel({ mode: "off", file, live: live.client, model: "claude-test" });
    expect(stepClient({ client: live.client, scripted: off }, "oracle.extract", "m")).toBe(live.client);
    expect(off.status()).toBe("live model claude-test");
  });
});
