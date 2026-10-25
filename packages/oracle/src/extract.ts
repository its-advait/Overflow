import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Repositories } from "@overflow/database";
import {
  FormatSchema,
  GranularitySchema,
  LicenseSchema,
  MoneyFormatError,
  ResourceRequestSchema,
  atomicToBigInt,
  formatUsdc,
  toAtomic,
  type Mission,
  type ResourceRequest,
} from "@overflow/schemas";
import type { Hex } from "viem";
import { z } from "zod";
import { outputHash, promptHash } from "./hash";

// ---------------------------------------------------------------------------
// Requirement extraction (docs/SPEC.md "Oracle" > Requirement extraction).
// Claude turns the mission goal into structured requests; the output is
// parsed by Zod, post-processed deterministically and validated against
// ResourceRequestSchema. One retry with the validation error, then a loud
// failure. Every call is audited with its prompt and output hash. The result
// is shown to the user for editing before anything is bought; it chooses no
// listing and authorizes no payment.
// ---------------------------------------------------------------------------

/** Model-facing shape: plain types only so the JSON Schema conversion keeps it exact. */
export const ExtractionOutputSchema = z.object({
  requests: z.array(
    z.object({
      topic: z.string(),
      /** Region codes from the vocabulary given in the prompt (e.g. US, US-CA). */
      regions: z.array(z.string()),
      dateRange: z.object({ start: z.string(), end: z.string() }),
      granularity: GranularitySchema,
      requiredFields: z.array(z.string()),
      format: z.array(FormatSchema),
      license: LicenseSchema,
      freshnessMaxAgeDays: z.number().int(),
      /** Human USDC amount as a decimal string, e.g. "12.50". */
      maxPriceUsdc: z.string(),
    }),
  ),
  assumptions: z.array(z.string()),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

export const EXTRACTION_SYSTEM_PROMPT = [
  "You turn a data-buying mission into structured resource requests for a procurement system.",
  "Return only the requested JSON. You propose requirements; you do not choose listings or sellers and you authorize nothing.",
  "Rules:",
  "- regions: use only codes from the region vocabulary given (US means the national aggregate; US-XX means state detail for that state). If the mission needs state-level detail nationwide, include US and every state code you need, or just US when any national dataset will do.",
  "- dateRange: calendar dates YYYY-MM-DD. Never end after today's date; data for the current month does not exist yet.",
  "- granularity: the finest resolution the mission needs (daily, weekly, monthly, quarterly, annual).",
  "- requiredFields: lowercase column names the mission must have.",
  "- format: every format the buyer can read.",
  "- license: company-use when more than one person or agent will use the data, single-user otherwise, unclear only if the mission says so.",
  "- freshnessMaxAgeDays: how old the data may be, in whole days.",
  "- maxPriceUsdc: a decimal string with at most 6 fractional digits, never above the mission budget.",
  "- assumptions: every choice the mission left open and how you resolved it.",
  "Produce one request per distinct need; most missions need exactly one.",
].join("\n");

export interface ExtractionInput {
  mission: Pick<Mission, "id" | "goal" | "budgetAtomic">;
  /** Region codes the catalog knows (e.g. from the listings' coverage). */
  knownRegions: readonly string[];
  /** Clock used for "today" and the date clamp. */
  now: Date;
}

export type ExtractionClient = { messages: { parse: Anthropic["messages"]["parse"] } };

export interface ExtractionDeps {
  client: ExtractionClient;
  /** Model id, from CLAUDE_MODEL. Never hardcoded. */
  model: string;
  /** activity_events writer; the service passes repos.activityEvents. */
  audit: Pick<Repositories["activityEvents"], "insert">;
}

export interface ModelCallRecord {
  attempt: number;
  model: string;
  promptHash: Hex;
  outputHash: Hex;
  outcome: "parsed" | "invalid";
}

export interface ExtractionResult {
  requests: ResourceRequest[];
  assumptions: string[];
  modelCalls: ModelCallRecord[];
}

export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly modelCalls: readonly ModelCallRecord[],
    public readonly issues: readonly string[],
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

/** CLAUDE_MODEL from the environment; fails loudly when unset. */
export function oracleModelFromEnv(env: Record<string, string | undefined> = process.env): string {
  const model = env["CLAUDE_MODEL"]?.trim();
  if (!model) throw new Error("CLAUDE_MODEL is not set; the Oracle never hardcodes a model id");
  return model;
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Last day of the last complete month before `now` (UTC), e.g. 2026-10-24 -> 2026-09-30. */
export function lastCompleteMonthEnd(now: Date): string {
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return isoDay(new Date(firstOfThisMonth.getTime() - 86_400_000));
}

/**
 * Listings cannot contain data for months that have not finished; a request
 * saying "2024-2026" is clamped to the last complete month. Returns the
 * assumption text when a change was made.
 */
export function clampToPresent(
  dateRange: { start: string; end: string },
  now: Date,
): { dateRange: { start: string; end: string }; assumption?: string } {
  const limit = lastCompleteMonthEnd(now);
  if (dateRange.end <= limit) return { dateRange };
  return {
    dateRange: { start: dateRange.start, end: limit },
    assumption: `dateRange.end ${dateRange.end} clamped to ${limit}, the last complete month before ${isoDay(now)}`,
  };
}

/** Deterministic post-processing of one model request, then ResourceRequestSchema validation. */
export function toResourceRequest(
  raw: ExtractionOutput["requests"][number],
  mission: ExtractionInput["mission"],
  now: Date,
): { request: ResourceRequest; assumptions: string[] } {
  const assumptions: string[] = [];
  const clamped = clampToPresent(raw.dateRange, now);
  if (clamped.assumption) assumptions.push(clamped.assumption);

  let maxPriceAtomic = toAtomic(raw.maxPriceUsdc.trim());
  if (atomicToBigInt(maxPriceAtomic) > atomicToBigInt(mission.budgetAtomic)) {
    assumptions.push(
      `maxPrice ${formatUsdc(maxPriceAtomic)} USDC clamped to the mission budget ${formatUsdc(mission.budgetAtomic)} USDC`,
    );
    maxPriceAtomic = mission.budgetAtomic;
  }

  const request = ResourceRequestSchema.parse({
    topic: raw.topic.trim(),
    regions: [...new Set(raw.regions.map((r) => r.trim()))],
    dateRange: clamped.dateRange,
    granularity: raw.granularity,
    requiredFields: [...new Set(raw.requiredFields.map((f) => f.trim().toLowerCase()))],
    format: [...new Set(raw.format)],
    license: raw.license,
    freshness: { maxAgeDays: raw.freshnessMaxAgeDays },
    maxPriceAtomic,
  });
  return { request, assumptions };
}

function describeIssues(e: unknown): string[] {
  if (e instanceof z.ZodError) return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  if (e instanceof MoneyFormatError) return [`maxPriceUsdc: ${e.message}`];
  return [e instanceof Error ? e.message : String(e)];
}

function missionTurn(input: ExtractionInput): string {
  return [
    `Today is ${isoDay(input.now)}.`,
    `Mission goal: ${input.mission.goal}`,
    `Mission budget: ${formatUsdc(input.mission.budgetAtomic)} USDC`,
    `Region vocabulary: ${input.knownRegions.length > 0 ? input.knownRegions.join(", ") : "(none given; use ISO 3166-2 style codes such as US, US-CA)"}`,
  ].join("\n");
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/**
 * Extracts ResourceRequests from a mission. Two model calls at most: the
 * second carries the first output and its validation errors. Each call is
 * recorded in activity_events as `oracle.model_call` with both hashes.
 */
export async function extractRequirements(input: ExtractionInput, deps: ExtractionDeps): Promise<ExtractionResult> {
  const format = zodOutputFormat(ExtractionOutputSchema);
  const schemaJson = JSON.stringify(format.schema);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: missionTurn(input) }];
  const modelCalls: ModelCallRecord[] = [];
  let lastIssues: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const userText = messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : textOf(m.content)))
      .join("\n---\n");
    const pHash = promptHash({ model: deps.model, system: EXTRACTION_SYSTEM_PROMPT, user: userText, schema: schemaJson });

    const response = await deps.client.messages.parse({
      model: deps.model,
      max_tokens: 16000,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages,
      output_config: { format },
    });
    const rawText = textOf(response.content);
    const oHash = outputHash(rawText);

    let outcome: ModelCallRecord["outcome"] = "invalid";
    let result: ExtractionResult | undefined;
    if (response.stop_reason !== "end_turn") {
      lastIssues = [`model stopped with ${String(response.stop_reason)} instead of end_turn`];
    } else if (response.parsed_output === null || response.parsed_output === undefined) {
      lastIssues = ["output did not parse against the extraction schema"];
    } else {
      try {
        const parsed = ExtractionOutputSchema.parse(response.parsed_output);
        if (parsed.requests.length === 0) throw new Error("requests: at least one request is required");
        const assumptions = [...parsed.assumptions];
        const requests: ResourceRequest[] = [];
        for (const r of parsed.requests) {
          const converted = toResourceRequest(r, input.mission, input.now);
          requests.push(converted.request);
          assumptions.push(...converted.assumptions);
        }
        outcome = "parsed";
        result = { requests, assumptions, modelCalls };
      } catch (e) {
        lastIssues = describeIssues(e);
      }
    }

    const record: ModelCallRecord = { attempt, model: deps.model, promptHash: pHash, outputHash: oHash, outcome };
    modelCalls.push(record);
    await deps.audit.insert({
      kind: "oracle.model_call",
      missionId: input.mission.id,
      message: `oracle extraction attempt=${attempt} model=${deps.model} promptHash=${pHash} outputHash=${oHash} outcome=${outcome}`,
      simulated: false,
    });

    if (result) return result;
    if (attempt === 1) {
      messages.push(
        { role: "assistant", content: rawText.length > 0 ? rawText : "(empty)" },
        {
          role: "user",
          content: `That output failed validation:\n${lastIssues.map((i) => `- ${i}`).join("\n")}\nReturn the corrected JSON.`,
        },
      );
    }
  }

  throw new ExtractionError(
    `requirement extraction failed after 2 attempts: ${lastIssues.join("; ")}`,
    modelCalls,
    lastIssues,
  );
}
