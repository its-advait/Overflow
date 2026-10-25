import type { Repositories } from "@overflow/database";
import type { Address, Hex } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActivityBus } from "../chain/bus.js";
import { createExceptionService } from "../exceptions/service.js";
import { b32, ESCROW, fixtureMissionAndResource, NOW, purchaseInput, SELLER, testDatabase, TREASURY } from "../test-db.js";
import { OracleUnavailableError } from "./oracle-port.js";
import { createPurchaseService } from "./purchase-service.js";
import { createSampleJudge, SAMPLE_SYSTEM_PROMPT, type SampleJudge } from "./sample-judgment.js";
import { fakeModel, fakeSeller, SAMPLE_ROWS } from "./sample-judgment.test-util.js";

describe("step 4: sample judgment", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  let repos: Repositories;
  let seq = 0;
  const seller = fakeSeller();

  beforeAll(async () => {
    handle = await testDatabase();
    repos = handle.repos;
    await fixtureMissionAndResource(repos);
    await repos.resourceRequests.insert({
      missionId: "mission-1",
      agentId: "agent-research",
      topic: "EV registrations",
      regions: ["United States"],
      dateRange: { start: "2024-01-01", end: "2025-12-31" },
      granularity: "monthly",
      requiredFields: ["brand", "units"],
      format: ["csv"],
      license: "company-use",
      freshness: { maxAgeDays: 90 },
      maxPriceAtomic: "20000000",
    });
  });
  afterAll(() => handle.close());

  /** A PROPOSED purchase with its escrow_orders row, backed by a fresh SIMULATED order on the fake seller. */
  async function proposed(opts: { swapIndex?: number; rootCipher?: Hex } = {}) {
    const n = ++seq;
    const resource = await repos.resources.insert({ ...(await repos.resources.getById("resource-1"))!, id: `resource-s${n}`, manifestHash: b32(100 + n) });
    const orderId = b32(1000 + n);
    const order = seller.addOrder({
      orderId,
      resourceId: resource.id,
      buyer: TREASURY,
      seller: SELLER,
      escrowAddress: `0x${(0x5000 + n).toString(16).padStart(40, "0")}` as Address,
      swapIndex: opts.swapIndex,
    });
    const purchases = createPurchaseService(handle.db);
    const { purchase } = await purchases.propose({
      purchase: purchaseInput({ id: `ps${n}`, resourceId: resource.id, orderIdBytes32: orderId, idempotencyKey: `k-ps${n}`, escrowAddress: order.escrow.escrowAddress }),
      escrow: { ...order.escrow, ...(opts.rootCipher ? { rootCipher: opts.rootCipher } : {}) },
      reason: "test",
      source: { kind: "oracle", reference: "t" },
      simulated: true,
    });
    return { purchase, order, resource };
  }

  function judgeWith(model: ReturnType<typeof fakeModel> | null, over: { sampleSize?: number; confidenceMin?: number } = {}): SampleJudge {
    const bus = createActivityBus();
    return createSampleJudge({
      db: handle.db,
      bus,
      exceptions: createExceptionService({ db: handle.db, treasury: TREASURY, bus }),
      purchases: createPurchaseService(handle.db),
      sellerUrl: seller.sellerUrl,
      fetch: seller.fetch,
      model: model?.model ?? null,
      sampleSize: over.sampleSize ?? 4,
      confidenceMin: over.confidenceMin ?? 0.7,
      now: () => new Date(NOW),
    });
  }

  it("buy: verifies cipher, manifest and sample, asks the model once, records hashes, signs nothing", async () => {
    const { purchase } = await proposed();
    const model = fakeModel([{ verdict: "buy", reason: "monthly US EV rows with brand and units", confidence: 0.92 }]);
    const judge = judgeWith(model);
    const before = { ...seller.calls };

    const r = await judge.judge(purchase.id);
    expect(r.outcome).toBe("buy");
    if (r.outcome !== "buy") throw new Error("unreachable");
    expect(r.sample.verdict).toBe("buy");
    expect(r.sample.confidence).toBe(0.92);
    expect(r.sample.indices).toHaveLength(4);
    expect(r.sample.promptHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.sample.outputHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(model.calls).toBe(1);
    expect(seller.calls).toEqual({ cipher: before.cipher + 1, manifest: before.manifest + 1, sample: before.sample + 1 });

    // The model saw the requirements, the listing and the decoded rows; the system prompt says it authorizes nothing.
    expect(model.users[0]).toContain("topic: EV registrations");
    expect(model.users[0]).toContain("index | timestamp (unix s) | brand,units,state");
    expect(SAMPLE_ROWS.filter((row) => model.users[0]!.includes(row)).length).toBe(4);
    expect(SAMPLE_SYSTEM_PROMPT).toMatch(/authorize nothing/);

    expect((await repos.purchases.getById(purchase.id))!.status).toBe("PROPOSED");
    const events = await repos.activityEvents.listByPurchase(purchase.id);
    expect(events.map((e) => e.kind)).toEqual(["purchase.proposed", "oracle.model_call", "oracle.sample"]);
    expect(events[1]!.message).toContain(`promptHash=${r.sample.promptHash}`);
    expect(events[2]!.message).toContain("verdict=buy confidence=0.92");
    expect(events[2]!.simulated).toBe(true);
    expect(judge.cached(purchase.id)?.cipherChunks).toHaveLength(SAMPLE_ROWS.length);

    // Second call: the stored sample is reused; no network, no model.
    const again = await judge.judge(purchase.id);
    expect(again).toEqual({ outcome: "buy", sample: r.sample });
    expect(model.calls).toBe(1);
    expect(seller.calls).toEqual({ cipher: before.cipher + 1, manifest: before.manifest + 1, sample: before.sample + 1 });
    expect(await repos.samples.listByPurchase(purchase.id)).toHaveLength(1);
  });

  it("skip: the purchase ends before funding with the model's reason, source oracle", async () => {
    const { purchase } = await proposed();
    const model = fakeModel([{ verdict: "skip", reason: "rows are US states; the mission needs EU countries", confidence: 0.8 }]);
    const r = await judgeWith(model).judge(purchase.id);
    expect(r.outcome).toBe("skip");
    const row = (await repos.purchases.getById(purchase.id))!;
    expect(row.status).toBe("FAILED_BEFORE_FUNDING");
    expect(row.authorizationDigest).toBeUndefined();
    const last = (await repos.activityEvents.listByPurchase(purchase.id)).at(-1)!;
    expect(last.message).toMatch(/^PROPOSED -> FAILED_BEFORE_FUNDING: sample verdict skip: rows are US states.*\[oracle:/);
  });

  it("low-confidence buy: held behind a LOW_CONFIDENCE_SAMPLE exception, purchase stays PROPOSED", async () => {
    const { purchase } = await proposed();
    const model = fakeModel([{ verdict: "buy", reason: "probably fits but the sample is thin", confidence: 0.4 }]);
    const judge = judgeWith(model);
    const r = await judge.judge(purchase.id);
    expect(r.outcome).toBe("held");
    if (r.outcome !== "held") throw new Error("unreachable");
    const exception = (await repos.exceptions.getById(r.exceptionId))!;
    expect(exception).toMatchObject({ type: "LOW_CONFIDENCE_SAMPLE", status: "open", requestedBy: "system:oracle", purchaseId: purchase.id, subject: `sample:${r.sample.id}` });
    expect(exception.details).toMatchObject({ sampleId: r.sample.id, confidence: 0.4 });
    expect((await repos.purchases.getById(purchase.id))!.status).toBe("PROPOSED");
    // Judging again reuses the sample and finds the same open exception; nothing new is raised.
    const again = await judge.judge(purchase.id);
    expect(again).toEqual({ outcome: "held", sample: r.sample, exceptionId: r.exceptionId });
    expect(model.calls).toBe(1);
    expect((await repos.exceptions.list("all")).filter((e) => e.purchaseId === purchase.id)).toHaveLength(1);
  });

  it("a chunk key that does not decrypt to the committed leaf is a skip decided by code, no model call", async () => {
    const { purchase } = await proposed({ swapIndex: 2 });
    const model = fakeModel([]);
    const r = await judgeWith(model, { sampleSize: 6 }).judge(purchase.id);
    expect(r.outcome).toBe("skip");
    if (r.outcome !== "skip") throw new Error("unreachable");
    expect(r.sample.verdict).toBe("skip");
    expect(r.sample.confidence).toBe(1);
    expect(r.sample.reason).toMatch(/sampled chunk 2 decrypt-mismatch/);
    expect(r.sample.promptHash).toBeUndefined();
    expect(model.calls).toBe(0);
    expect((await repos.purchases.getById(purchase.id))!.status).toBe("FAILED_BEFORE_FUNDING");
    const kinds = (await repos.activityEvents.listByPurchase(purchase.id)).map((e) => e.kind);
    expect(kinds).toEqual(["purchase.proposed", "oracle.sample", "purchase.status"]);
  });

  it("a ciphertext that does not Merkle to the escrow's rootCipher fails before any sample or model call", async () => {
    const { purchase } = await proposed({ rootCipher: b32(0xbad) });
    const model = fakeModel([]);
    const before = { ...seller.calls };
    const r = await judgeWith(model).judge(purchase.id);
    expect(r).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/ciphertext does not match rootCipher/) });
    expect(model.calls).toBe(0);
    expect(seller.calls.sample).toBe(before.sample);
    expect((await repos.purchases.getById(purchase.id))!.status).toBe("FAILED_BEFORE_FUNDING");
    expect(await repos.samples.listByPurchase(purchase.id)).toEqual([]);
  });

  it("without a model it refuses up front and touches neither the seller nor the purchase", async () => {
    const { purchase } = await proposed();
    const before = { ...seller.calls };
    await expect(judgeWith(null).judge(purchase.id)).rejects.toBeInstanceOf(OracleUnavailableError);
    expect(seller.calls).toEqual(before);
    expect((await repos.purchases.getById(purchase.id))!.status).toBe("PROPOSED");
  });

  it("refuses a purchase that is not PROPOSED", async () => {
    const { purchase } = await proposed();
    await createPurchaseService(handle.db).transition(purchase.id, "FAILED_BEFORE_FUNDING", { reason: "t", source: { kind: "api", reference: "t" } });
    await expect(judgeWith(fakeModel([])).judge(purchase.id)).rejects.toThrow(/FAILED_BEFORE_FUNDING/);
    expect(seller.calls.cipher).toBeGreaterThan(0);
  });
});
