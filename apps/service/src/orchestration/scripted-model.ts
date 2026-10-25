import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { maybeParseMessage } from "@anthropic-ai/sdk/lib/parser";
import type { ActivityEventInsert } from "@overflow/database";
import { promptHash } from "@overflow/oracle";
import type { ActivityEvent, Hex } from "@overflow/schemas";
import { z } from "zod";
import type { PlannerClient } from "./mission-runner.js";

// ---------------------------------------------------------------------------------------------------
// SCRIPTED replay (docs/SPEC.md "Scripted replay"; the labeled fallback of Leash's DEMO_SCRIPTED).
//
// Only the model's outputs are replaced. In `record` mode every model call goes to the API as usual and
// its answer is saved under its step key, in call order. In `replay` mode the saved answer is returned
// instead of calling the API, and the call site runs the same Zod validation it runs live. Everything
// after the model (order terms, signing, settle, escrow, indexing, ledger) is untouched: replay never
// fakes a chain result. A missing or exhausted recording fails loudly; nothing is invented.
//
// Every replayed call is logged with a [SCRIPTED] prefix and written as an `oracle.model_call`
// activity event that says so, and GET / reports the mode so the web top bar shows the SCRIPTED badge.
// ---------------------------------------------------------------------------------------------------

export const SCRIPTED_MODES = ["off", "record", "replay"] as const;
export type ScriptedMode = (typeof SCRIPTED_MODES)[number];

/** One key per model-call site; a site that calls more than once consumes its key's entries in order. */
export const STEP_KEYS = ["oracle.extract", "sample.judge", "mission.plan", "mission.synthesize", "agent.research", "agent.finance", "agent.verification"] as const;
export const StepKeySchema = z.enum(STEP_KEYS);
export type StepKey = z.infer<typeof StepKeySchema>;

const Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** The content the five call sites consume: text and tool_use blocks only. */
export const RecordedBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_use"), id: z.string().min(1), name: z.string().min(1), input: z.unknown() }),
]);
export type RecordedBlock = z.infer<typeof RecordedBlockSchema>;

export const RecordedCallSchema = z.object({
  /** 1-based position within the step. */
  n: z.number().int().positive(),
  /** promptHash() of the live request at record time (fixed ABI fields: model, system, user turns, schema). */
  promptHash: Bytes32,
  stopReason: z.string().nullable(),
  content: z.array(RecordedBlockSchema),
  usage: z.object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) }).optional(),
  recordedAt: z.string(),
});
export type RecordedCall = z.infer<typeof RecordedCallSchema>;

export const ScriptedRecordingSchema = z.object({
  version: z.literal(1),
  /** Always true: a recording is a scripted artifact. Labeled so no reader mistakes it for live data. */
  scripted: z.literal(true),
  name: z.string().min(1),
  recordedAt: z.string(),
  /** CLAUDE_MODEL that answered at record time. */
  model: z.string().min(1),
  /** The one mission the recording holds (steps from other missions are not recorded). */
  scope: z.object({ missionId: z.string().min(1) }).nullable(),
  steps: z.partialRecord(StepKeySchema, z.array(RecordedCallSchema)),
});
export type ScriptedRecording = z.infer<typeof ScriptedRecordingSchema>;

export interface RecordingSummary {
  name: string;
  file: string;
  recordedAt: string;
  model: string;
  scope: { missionId: string } | null;
  steps: Partial<Record<StepKey, number>>;
}

export class ScriptedRecordingError extends Error {
  constructor(message: string) {
    super(`scripted recording: ${message}`);
    this.name = "ScriptedRecordingError";
  }
}

/** Replay had no recorded answer for this call. The caller sees a failed model call; nothing is fabricated. */
export class ScriptedReplayError extends Error {
  constructor(
    public readonly step: StepKey,
    public readonly missionId: string,
    public readonly n: number,
    message: string,
  ) {
    super(`SCRIPTED replay ${step}#${n} for mission ${missionId}: ${message}`);
    this.name = "ScriptedReplayError";
  }
}

export interface ScriptedModelOptions {
  mode: ScriptedMode;
  /** Recording path (read in replay, written in record). */
  file: string;
  /** The real Anthropic client; required in record and off modes, ignored in replay. */
  live: PlannerClient | null;
  /** CLAUDE_MODEL; may be null in replay (the recording's model is used). */
  model: string | null;
  /** activity_events writer and live feed for the per-call SCRIPTED audit (replay only). */
  audit?: { insert(input: ActivityEventInsert): Promise<ActivityEvent> } | undefined;
  publish?: ((event: ActivityEvent) => void) | undefined;
  log?: ((line: string) => void) | undefined;
  now?: (() => Date) | undefined;
}

export interface ScriptedModel {
  readonly mode: ScriptedMode;
  /** Model id the call sites report: CLAUDE_MODEL, or the recording's model in replay. */
  readonly model: string;
  readonly recording: RecordingSummary | null;
  /** A client for one call site and one mission. In `off` mode this is the live client itself. */
  forStep(step: StepKey, missionId: string): PlannerClient;
  /** One line for GET / and the boot log. */
  status(): string;
}

type ParseParams = Parameters<PlannerClient["messages"]["parse"]>[0];
type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: unknown) => {
      if (!b || typeof b !== "object") return "";
      const block = b as { type?: string; text?: string; content?: unknown };
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "tool_result") return `[tool_result] ${textOf(block.content)}`;
      return "";
    })
    .join("\n");
};

/** Fixed-field hash of a request: model, system, the user turns in order, and the schema (output format or tools). */
export function requestHash(params: ParseParams | CreateParams): Hex {
  const format = (params as ParseParams).output_config?.format;
  const schema = format && "schema" in format ? format.schema : (params as CreateParams).tools ?? null;
  return promptHash({
    model: params.model,
    system: textOf(params.system),
    user: params.messages.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n---\n"),
    schema: JSON.stringify(schema ?? null),
  });
}

export function loadRecording(file: string): ScriptedRecording {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new ScriptedRecordingError(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new ScriptedRecordingError(`${file} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = ScriptedRecordingSchema.safeParse(json);
  if (!parsed.success) {
    throw new ScriptedRecordingError(`${file} failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function summarize(recording: ScriptedRecording, file: string): RecordingSummary {
  const steps: Partial<Record<StepKey, number>> = {};
  for (const [k, calls] of Object.entries(recording.steps)) if (calls) steps[k as StepKey] = calls.length;
  return { name: recording.name, file, recordedAt: recording.recordedAt, model: recording.model, scope: recording.scope, steps };
}

function recordedBlocks(content: ReadonlyArray<Anthropic.ContentBlock>): RecordedBlock[] {
  const out: RecordedBlock[] = [];
  for (const b of content) {
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    // Other block kinds (thinking, server tools) are not consumed by any call site and are not recorded.
  }
  return out;
}

function messageFrom(call: RecordedCall, step: StepKey, model: string): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = call.content.map((b) =>
    b.type === "text" ? { type: "text", text: b.text, citations: null } : ({ type: "tool_use", id: b.id, name: b.name, input: b.input } as Anthropic.ToolUseBlock),
  );
  const message = {
    id: `scripted-${step}-${call.n}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: call.stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    diagnostics: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null },
  };
  return message as unknown as Anthropic.Message;
}

export function createScriptedModel(opts: ScriptedModelOptions): ScriptedModel {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? (() => new Date());
  const name = basename(opts.file, extname(opts.file));

  if (opts.mode === "off") {
    if (!opts.live || !opts.model) throw new ScriptedRecordingError("off mode needs the live client and CLAUDE_MODEL");
    const live = opts.live;
    const model = opts.model;
    return { mode: "off", model, recording: null, forStep: () => live, status: () => `live model ${model}` };
  }

  if (opts.mode === "record") {
    if (!opts.live || !opts.model) throw new ScriptedRecordingError("record mode needs ANTHROPIC_API_KEY and CLAUDE_MODEL: the recording is made from real model answers");
    const live = opts.live;
    const model = opts.model;
    const recording: ScriptedRecording = { version: 1, scripted: true, name, recordedAt: now().toISOString(), model, scope: null, steps: {} };

    const save = (): void => {
      ScriptedRecordingSchema.parse(recording);
      mkdirSync(dirname(opts.file), { recursive: true });
      const tmp = `${opts.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(recording, null, 2)}\n`);
      renameSync(tmp, opts.file);
    };

    const record = (step: StepKey, missionId: string, params: ParseParams | CreateParams, response: Anthropic.Message): void => {
      if (recording.scope === null) recording.scope = { missionId };
      if (recording.scope.missionId !== missionId) {
        log(`[RECORDING] skipped ${step} for mission ${missionId}: recording ${name} holds mission ${recording.scope.missionId}`);
        return;
      }
      const calls = (recording.steps[step] ??= []);
      calls.push({
        n: calls.length + 1,
        promptHash: requestHash(params),
        stopReason: response.stop_reason,
        content: recordedBlocks(response.content),
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        recordedAt: now().toISOString(),
      });
      save();
      log(`[RECORDING] saved ${step}#${calls.length} (${response.stop_reason}) to ${opts.file}`);
    };

    return {
      mode: "record",
      model,
      get recording() {
        return summarize(recording, opts.file);
      },
      status: () => `live model ${model}, RECORDING model answers to ${opts.file}`,
      forStep(step, missionId) {
        return {
          messages: {
            async create(params) {
              const response = await live.messages.create(params);
              record(step, missionId, params, response);
              return response;
            },
            parse: (async (params: ParseParams) => {
              const response = await live.messages.parse(params);
              record(step, missionId, params, response);
              return response;
            }) as PlannerClient["messages"]["parse"],
          },
        };
      },
    };
  }

  // replay
  const recording = loadRecording(opts.file);
  const model = recording.model;
  const summary = summarize(recording, opts.file);
  const cursors = new Map<string, number>();

  const next = async (step: StepKey, missionId: string, params: ParseParams | CreateParams): Promise<Anthropic.Message> => {
    const key = `${missionId}:${step}`;
    const n = (cursors.get(key) ?? 0) + 1;
    cursors.set(key, n);
    const calls = recording.steps[step] ?? [];
    const call = calls[n - 1];
    if (!call) {
      const why = calls.length === 0 ? `recording ${name} has no ${step} calls` : `recording ${name} has only ${calls.length} ${step} call(s)`;
      log(`[SCRIPTED] replay ${step}#${n} FAILED: ${why}; no API call made`);
      throw new ScriptedReplayError(step, missionId, n, why);
    }
    const matches = requestHash(params) === call.promptHash;
    const hashNote = matches ? "prompt hash matches the recording" : "prompt hash differs from the recording";
    log(`[SCRIPTED] replay ${step}#${n} from ${name} (${hashNote}); no API call made`);
    if (opts.audit) {
      const event = await opts.audit.insert({
        kind: "oracle.model_call",
        missionId,
        message: `SCRIPTED replay: ${step}#${n} from recording ${name} (recorded model ${model}, ${hashNote}); no API call made`,
        simulated: false,
      });
      opts.publish?.(event);
    }
    return messageFrom(call, step, model);
  };

  return {
    mode: "replay",
    model,
    recording: summary,
    status: () => `SCRIPTED replay from ${opts.file} (recorded ${summary.recordedAt} with ${model}; ${Object.entries(summary.steps).map(([k, v]) => `${k}=${v}`).join(", ") || "no steps"}); the API is never called`,
    forStep(step, missionId) {
      return {
        messages: {
          create: (params) => next(step, missionId, params),
          parse: (async (params: ParseParams) => {
            const message = await next(step, missionId, params);
            // The call site's own zodOutputFormat parse runs here, as it does on a live answer.
            return maybeParseMessage(message, params, { logger: console });
          }) as PlannerClient["messages"]["parse"],
        },
      };
    },
  };
}

/** The client a call site uses for one step of one mission: scripted when a scripted model is wired, live otherwise. */
export function stepClient<C>(model: { client: C; scripted?: ScriptedModel | undefined }, step: StepKey, missionId: string): C {
  if (!model.scripted || model.scripted.mode === "off") return model.client;
  return model.scripted.forStep(step, missionId) as unknown as C;
}
