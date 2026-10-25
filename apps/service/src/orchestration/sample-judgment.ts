import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createRepositories, NotFoundError, type Db } from "@overflow/database";
import { outputHash, promptHash } from "@overflow/oracle";
import {
  buildTree,
  DatasetManifestSchema,
  decryptChunkWithChunkKey,
  getProof,
  hashLeaf,
  parseChunk,
  pickSampleIndices,
  splitDataset,
  verifyCiphertext,
  verifySample,
  type DatasetManifest,
} from "@overflow/recourse-crypto";
import {
  assertTransition,
  type ActivityEvent,
  type EscrowOrder,
  type PurchaseRecord,
  type ResourceRecord,
  type ResourceRequestRecord,
  type SampleRecord,
} from "@overflow/schemas";
import { toHex, type Hex } from "viem";
import { z } from "zod";
import { NotWiredError } from "../api/ports.js";
import type { ActivityBus } from "../chain/bus.js";
import type { ExceptionService } from "../exceptions/service.js";
import { SampleResponseSchema } from "../sellers/recourse/protocol.js";
import { OracleUnavailableError, type OracleModel } from "./oracle-port.js";
import type { PurchaseService } from "./purchase-service.js";

// ---------------------------------------------------------------------------
// Step 4 of docs/SPEC.md "One purchase, end to end": sample before paying.
//
// Code does every check that can be done by code: the ciphertext Merkles to the
// escrow's rootCipher, the manifest's rootPlain / chunkCount equal the escrow
// row, and each sampled chunk key decrypts its ciphertext chunk to the committed
// plain leaf (verifySample, both proofs). Only when the sample is cryptographically
// consistent does the model see the decoded rows, and it answers one question:
// does this data fit the mission's requirements? Its answer is a verdict with a
// confidence; it authorizes nothing. A "skip", a mismatch, or a "buy" below the
// confidence floor all end here, before anything is signed.
//
// Everything the judge does is recorded: `oracle.model_call` with prompt and
// output hashes (ABI-encoded fields, never JSON), a `samples` row, and an
// `oracle.sample` activity event on the purchase.
// ---------------------------------------------------------------------------

export const SampleJudgmentOutputSchema = z.object({
  verdict: z.enum(["buy", "skip"]),
  /** One or two sentences a controller can read: what matched, what did not. */
  reason: z.string().min(1).max(2000),
  /** 0..1, how sure the model is of the verdict. A score, not money. */
  confidence: z.number().min(0).max(1),
});
export type SampleJudgmentOutput = z.infer<typeof SampleJudgmentOutputSchema>;

export const SAMPLE_SYSTEM_PROMPT = `You are Overflow's sample judge. A team of AI agents wants to buy a dataset for a mission. Before any money moves, a random sample of the dataset's rows was decrypted and cryptographically verified against the seller's commitment. Your only job is to judge whether the SAMPLE fits the mission's confirmed requirements and the seller's listed coverage.

Rules:
- Judge fit on what the rows contain: topic, regions, time range, granularity and the required fields. A listing can cover more than the mission needs; that is fine. Rows that are about something else, outside the region or period, or missing required fields are a poor fit.
- The sample is small. Say how confident you are (0 = guessing, 1 = certain). Rows that clearly match on every requirement deserve high confidence; a sample that is ambiguous, too thin to judge, or partially off-target deserves lower confidence, and a mismatch deserves "skip".
- You authorize nothing and move no money. Your verdict is advice: "buy" means the sample fits, "skip" means it does not. Someone else decides whether to pay.
- Answer only in the requested JSON format.`;

export class SampleFetchError extends Error {
  constructor(
    public readonly what: "cipher" | "manifest" | "sample",
    public readonly status: number | undefined,
    message: string,
  ) {
    super(`seller ${what} request failed: ${message}`);
    this.name = "SampleFetchError";
  }
}

/** The model answered, but not with a verdict (wrong stop reason or output that fails the schema). The call is audited; nothing else changed. */
export class SampleModelError extends Error {
  constructor(
    public readonly promptHash: Hex,
    public readonly outputHash: Hex,
    message: string,
  ) {
    super(`sample judgment model call failed: ${message}`);
    this.name = "SampleModelError";
  }
}

export type SampleFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface SampleCache {
  cipherChunks: Uint8Array[];
  plainLeaves: Hex[];
  manifest: DatasetManifest;
}

export type SampleJudgment =
  | { outcome: "buy"; sample: SampleRecord }
  | { outcome: "held"; sample: SampleRecord; exceptionId: string }
  | { outcome: "skip"; sample: SampleRecord; reason: string }
  /** The ciphertext or manifest did not match the escrow commitment; no sample was taken and nothing was asked of the model. */
  | { outcome: "failed"; reason: string };

export interface SampleJudge {
  judge(purchaseId: string): Promise<SampleJudgment>;
  /** Cipher chunks, plain leaves and manifest the judge fetched for the purchase (step 9 reuses them; undefined after a restart). */
  cached(purchaseId: string): SampleCache | undefined;
}

export interface SampleJudgeDeps {
  db: Db;
  bus?: ActivityBus | undefined;
  exceptions: ExceptionService;
  purchases: PurchaseService;
  /** Base URL of the SIMULATED Recourse seller app; URLs are rebuilt from the order id and resource id. */
  sellerUrl: string;
  fetch: SampleFetch;
  /** Anthropic client + CLAUDE_MODEL. null: judge() throws OracleUnavailableError before touching the network. */
  model: OracleModel | null;
  sampleSize: number;
  confidenceMin: number;
  now?: (() => Date) | undefined;
  log?: ((message: string) => void) | undefined;
}

const SOURCE = { kind: "oracle" as const };

export function createSampleJudge(deps: SampleJudgeDeps): SampleJudge {
  const repos = createRepositories(deps.db);
  const cache = new Map<string, SampleCache>();
  const log = deps.log ?? (() => undefined);
  const publish = (event: ActivityEvent): void => {
    try {
      deps.bus?.publish(event);
    } catch (e) {
      console.warn("[sample] publish hook threw", e);
    }
  };

  async function fail(purchase: PurchaseRecord, resource: ResourceRecord, reason: string): Promise<SampleJudgment> {
    await deps.purchases.transition(purchase.id, "FAILED_BEFORE_FUNDING", {
      reason,
      source: { ...SOURCE, reference: purchase.id },
      simulated: resource.simulated,
    });
    return { outcome: "failed", reason };
  }

  /** The verdict's consequence: skip ends the purchase; a low-confidence buy asks the controller; otherwise buy. */
  async function settle(purchase: PurchaseRecord, resource: ResourceRecord, sample: SampleRecord): Promise<SampleJudgment> {
    if (sample.verdict === "skip") {
      const current = await repos.purchases.getById(purchase.id);
      if (current?.status === "PROPOSED") {
        await deps.purchases.transition(purchase.id, "FAILED_BEFORE_FUNDING", {
          reason: `sample verdict skip: ${sample.reason}`,
          source: { ...SOURCE, reference: sample.id },
          simulated: resource.simulated,
        });
      }
      return { outcome: "skip", sample, reason: sample.reason };
    }
    const confidence = sample.confidence ?? 0;
    if (confidence < deps.confidenceMin) {
      const raised = await deps.exceptions.raise({
        type: "LOW_CONFIDENCE_SAMPLE",
        requestedBy: "system:oracle",
        reason: `sample verdict buy at confidence ${confidence.toFixed(2)} (minimum ${deps.confidenceMin}): ${sample.reason}`,
        purchaseId: purchase.id,
        sampleId: sample.id,
        confidence,
      });
      return { outcome: "held", sample, exceptionId: raised.exception.id };
    }
    return { outcome: "buy", sample };
  }

  async function fetchCipher(order: EscrowOrder): Promise<Uint8Array[]> {
    const url = `${deps.sellerUrl}/orders/${order.orderIdBytes32}/cipher`;
    let res: Response;
    try {
      res = await deps.fetch(url);
    } catch (e) {
      throw new SampleFetchError("cipher", undefined, e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw new SampleFetchError("cipher", res.status, `HTTP ${res.status} from ${url}`);
    return splitDataset(new Uint8Array(await res.arrayBuffer()));
  }

  async function fetchManifest(resourceId: string): Promise<DatasetManifest> {
    const url = `${deps.sellerUrl}/r/${resourceId}/manifest`;
    let res: Response;
    try {
      res = await deps.fetch(url);
    } catch (e) {
      throw new SampleFetchError("manifest", undefined, e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw new SampleFetchError("manifest", res.status, `HTTP ${res.status} from ${url}`);
    return DatasetManifestSchema.parse(await res.json());
  }

  async function fetchSample(order: EscrowOrder, indices: number[]): Promise<Map<number, Hex>> {
    const url = `${deps.sellerUrl}/orders/${order.orderIdBytes32}/sample`;
    let res: Response;
    try {
      res = await deps.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ indices }) });
    } catch (e) {
      throw new SampleFetchError("sample", undefined, e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw new SampleFetchError("sample", res.status, `HTTP ${res.status} from ${url}`);
    const body = SampleResponseSchema.parse(await res.json());
    if (body.orderId.toLowerCase() !== order.orderIdBytes32.toLowerCase()) {
      throw new SampleFetchError("sample", res.status, `reveals are for order ${body.orderId}, not ${order.orderIdBytes32}`);
    }
    return new Map(body.reveals.map((r) => [r.index, r.chunkKey]));
  }

  async function askModel(
    model: OracleModel,
    purchase: PurchaseRecord,
    requests: ResourceRequestRecord[],
    resource: ResourceRecord,
    manifest: DatasetManifest,
    rows: { index: number; timestamp: bigint; row: string }[],
  ): Promise<{ output: SampleJudgmentOutput; promptHash: Hex; outputHash: Hex }> {
    const format = zodOutputFormat(SampleJudgmentOutputSchema);
    const schemaJson = JSON.stringify(format.schema);
    const userText = sampleTurn(requests, resource, manifest, rows);
    const pHash = promptHash({ model: model.model, system: SAMPLE_SYSTEM_PROMPT, user: userText, schema: schemaJson });
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userText }];
    const response = await model.client.messages.parse({
      model: model.model,
      max_tokens: 2000,
      system: SAMPLE_SYSTEM_PROMPT,
      messages,
      output_config: { format },
    });
    const rawText = textOf(response.content);
    const oHash = outputHash(rawText);

    let output: SampleJudgmentOutput | undefined;
    let issue: string | undefined;
    if (response.stop_reason !== "end_turn") issue = `model stopped with ${String(response.stop_reason)} instead of end_turn`;
    else {
      const parsed = SampleJudgmentOutputSchema.safeParse(response.parsed_output);
      if (parsed.success) output = parsed.data;
      else issue = `output did not parse against the sample judgment schema: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
    }
    const audit = await repos.activityEvents.insert({
      kind: "oracle.model_call",
      purchaseId: purchase.id,
      missionId: purchase.missionId,
      message: `oracle sample judgment model=${model.model} promptHash=${pHash} outputHash=${oHash} outcome=${output ? "parsed" : "invalid"}`,
      simulated: resource.simulated,
    });
    publish(audit);
    if (!output) throw new SampleModelError(pHash, oHash, issue ?? "no output");
    return { output, promptHash: pHash, outputHash: oHash };
  }

  async function record(
    purchase: PurchaseRecord,
    resource: ResourceRecord,
    input: { indices: number[]; verdict: "buy" | "skip"; reason: string; confidence: number; promptHash?: Hex; outputHash?: Hex; by: "code" | "model" },
  ): Promise<SampleRecord> {
    const { sample, event } = await deps.db.transaction(async (tx) => {
      const r = createRepositories(tx);
      const sample = await r.samples.insert({
        purchaseId: purchase.id,
        indices: input.indices,
        verdict: input.verdict,
        reason: input.reason,
        confidence: input.confidence,
        ...(input.promptHash ? { promptHash: input.promptHash } : {}),
        ...(input.outputHash ? { outputHash: input.outputHash } : {}),
        ...(deps.now ? { createdAt: deps.now().toISOString() } : {}),
      });
      const event = await r.activityEvents.insert({
        kind: "oracle.sample",
        purchaseId: purchase.id,
        missionId: purchase.missionId,
        message: `sample ${sample.id} of ${input.indices.length} chunk(s) judged by ${input.by}: verdict=${input.verdict} confidence=${input.confidence.toFixed(2)} reason=${input.reason}`,
        simulated: resource.simulated,
      });
      return { sample, event };
    });
    publish(event);
    return sample;
  }

  return {
    cached: (purchaseId) => cache.get(purchaseId),

    async judge(purchaseId) {
      const purchase = await repos.purchases.getById(purchaseId);
      if (!purchase) throw new NotFoundError("purchases", purchaseId);
      // Only a PROPOSED purchase can be sampled (same gate as the authorization it precedes).
      assertTransition(purchase.status, "RESERVED");
      const resource = await repos.resources.getById(purchase.resourceId);
      if (!resource) throw new NotFoundError("resources", purchase.resourceId);

      // Idempotent: one sample, one model call per purchase. A stored verdict is reused as is.
      const [existing] = await repos.samples.listByPurchase(purchaseId);
      if (existing) {
        log(`[sample] ${purchaseId}: reusing sample ${existing.id} (${existing.verdict})`);
        return settle(purchase, resource, existing);
      }
      if (!deps.model) throw new OracleUnavailableError("set ANTHROPIC_API_KEY and CLAUDE_MODEL; the sample judgment needs the model");

      const escrow = await repos.escrowOrders.getByPurchase(purchaseId);
      if (!escrow) throw new NotFoundError("escrow_orders", purchaseId);
      const requests = (await repos.resourceRequests.listByMission(purchase.missionId)).filter((r) => r.status !== "withdrawn");

      // 1. The ciphertext the seller serves must be the one it committed to on chain.
      let cipherChunks: Uint8Array[];
      try {
        cipherChunks = await fetchCipher(escrow);
      } catch (e) {
        if (e instanceof SampleFetchError) throw e;
        return fail(purchase, resource, `ciphertext unreadable, not signed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!verifyCiphertext(cipherChunks, escrow.rootCipher, cipherChunks.length)) {
        return fail(purchase, resource, `ciphertext does not match rootCipher ${escrow.rootCipher} (${cipherChunks.length} chunks), not signed`);
      }

      // 2. The manifest's plain commitment must be the escrow's.
      const manifest = await fetchManifest(purchase.resourceId);
      if (manifest.rootPlain.toLowerCase() !== escrow.rootPlain.toLowerCase()) {
        return fail(purchase, resource, `manifest rootPlain ${manifest.rootPlain} differs from the escrow's ${escrow.rootPlain}, not signed`);
      }
      if (manifest.chunkCount !== cipherChunks.length) {
        return fail(purchase, resource, `manifest chunkCount ${manifest.chunkCount} differs from the ciphertext's ${cipherChunks.length} chunks, not signed`);
      }
      const plainLeaves = manifest.plainLeaves as Hex[];
      const plainTree = buildTree(plainLeaves);
      if (plainTree.root.toLowerCase() !== escrow.rootPlain.toLowerCase()) {
        return fail(purchase, resource, `manifest plainLeaves do not Merkle to rootPlain ${escrow.rootPlain}, not signed`);
      }
      const cipherTree = buildTree(cipherChunks.map(hashLeaf));
      cache.set(purchaseId, { cipherChunks, plainLeaves, manifest });

      // 3. Random sample of chunk keys; every reveal must decrypt to the committed plain leaf.
      const count = Math.min(deps.sampleSize, cipherChunks.length);
      const indices = pickSampleIndices(cipherChunks.length, count, toHex(randomBytes(32)));
      const reveals = await fetchSample(escrow, indices);
      const rows: { index: number; timestamp: bigint; row: string }[] = [];
      for (const index of indices) {
        const chunkKey = reveals.get(index);
        if (!chunkKey) {
          return fail(purchase, resource, `seller did not reveal the key for sampled chunk ${index}, not signed`);
        }
        const verdict = verifySample(cipherChunks[index]!, chunkKey, plainLeaves[index]!, {
          index,
          cipherProof: getProof(cipherTree, index),
          plainProof: getProof(plainTree, index),
          rootCipher: escrow.rootCipher,
          rootPlain: escrow.rootPlain,
          chunkCount: cipherChunks.length,
        });
        if (!verdict.ok) {
          // Decided by code: the committed ciphertext does not decrypt to the committed plaintext. No model call.
          const reason = `sampled chunk ${index} ${verdict.reason}: ${verdict.detail}`;
          log(`[sample] ${purchaseId}: ${reason}`);
          const sample = await record(purchase, resource, { indices, verdict: "skip", reason, confidence: 1, by: "code" });
          return settle(purchase, resource, sample);
        }
        let parsed: ReturnType<typeof parseChunk>;
        try {
          parsed = parseChunk(decryptChunkWithChunkKey(cipherChunks[index]!, chunkKey));
        } catch (e) {
          const reason = `sampled chunk ${index} decrypts to the committed leaf but is not a record: ${e instanceof Error ? e.message : String(e)}`;
          const sample = await record(purchase, resource, { indices, verdict: "skip", reason, confidence: 1, by: "code" });
          return settle(purchase, resource, sample);
        }
        rows.push({ index, timestamp: parsed.timestamp, row: parsed.row });
      }

      // 4. The model judges fit. It sees decoded rows and requirements; it cannot sign or pay.
      const { output, promptHash: pHash, outputHash: oHash } = await askModel(deps.model, purchase, requests, resource, manifest, rows);
      const sample = await record(purchase, resource, {
        indices,
        verdict: output.verdict,
        reason: output.reason,
        confidence: output.confidence,
        promptHash: pHash,
        outputHash: oHash,
        by: "model",
      });
      log(`[sample] ${purchaseId}: model verdict ${output.verdict} confidence ${output.confidence.toFixed(2)}`);
      return settle(purchase, resource, sample);
    },
  };
}

/** Default when no seller / model is configured: refuses, never pretends a sample was judged. */
export function notWiredSampleJudge(): SampleJudge {
  return {
    cached: () => undefined,
    judge: async () => {
      throw new NotWiredError("SampleJudge (seller URL + Anthropic model)", "SELLER_URL + CLAUDE_MODEL");
    },
  };
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/** The user turn: requirements, listing coverage, then the verified sample as a small table. Deterministic for the prompt hash. */
export function sampleTurn(
  requests: readonly ResourceRequestRecord[],
  resource: ResourceRecord,
  manifest: DatasetManifest,
  rows: readonly { index: number; timestamp: bigint; row: string }[],
): string {
  const lines: string[] = [];
  lines.push("## Mission requirements (confirmed by the owner)");
  if (requests.length === 0) lines.push("(none recorded)");
  for (const r of requests) {
    lines.push(
      `- topic: ${r.topic}; regions: ${r.regions.join(", ")}; dates: ${r.dateRange.start} to ${r.dateRange.end}; granularity: ${r.granularity}; required fields: ${r.requiredFields.join(", ") || "(any)"}; status: ${r.status}`,
    );
  }
  lines.push("");
  lines.push(`## Listing${resource.simulated ? " (SIMULATED seller)" : ""}`);
  const c = resource.coverage;
  lines.push(`- title: ${resource.title}`);
  lines.push(`- regions: ${c.regions.join(", ")}; dates: ${c.dateRange.start} to ${c.dateRange.end}; granularity: ${c.granularity}; fields: ${c.fields.join(", ")}; format: ${c.format}`);
  lines.push(`- manifest: ${manifest.title}; ${manifest.chunkCount} records; granularity ${manifest.granularity}; fields: ${manifest.fields.join(", ")}`);
  lines.push("");
  lines.push(`## Verified sample (${rows.length} of ${manifest.chunkCount} records, decrypted and checked against the seller's commitment)`);
  lines.push(`index | timestamp (unix s) | ${manifest.header}`);
  for (const r of rows) lines.push(`${r.index} | ${r.timestamp.toString()} | ${r.row}`);
  return lines.join("\n");
}
