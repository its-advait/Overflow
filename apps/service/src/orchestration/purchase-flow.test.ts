import { QuoteMismatchError, type PaymentRequirements } from "@overflow/payment-client";
import type { PurchaseOrder, SampleRecord } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotWiredError, type PaymentAdapter, type PaymentSubmission } from "../api/ports.js";
import { createActivityBus } from "../chain/bus.js";
import { createExceptionService } from "../exceptions/service.js";
import { ATTACKER, b32, fixtureMissionAndResource, NOW, purchaseInput, quoteFor, testDatabase, TREASURY } from "../test-db.js";
import { createPurchaseFlow, SampleHeldError, SampleRefusedError } from "./purchase-flow.js";
import { createPurchaseService } from "./purchase-service.js";
import type { SampleJudge, SampleJudgment } from "./sample-judgment.js";

function fakeAdapter(quote: (o: PurchaseOrder) => PaymentRequirements, submission: PaymentSubmission = { outcome: "submitted", txHash: b32(0x77) }) {
  const calls = { requirements: 0, prepare: 0, submit: 0 };
  const adapter: PaymentAdapter = {
    path: "overflow-facilitator",
    async getPaymentRequirements(order) {
      calls.requirements++;
      return quote(order);
    },
    async preparePayment() {
      calls.prepare++;
      return { authorizationDigest: b32(0xd1) };
    },
    async submitPayment() {
      calls.submit++;
      return submission;
    },
    async reconcilePayment() {
      return { status: "unknown" };
    },
  };
  return { adapter, calls };
}

const sampleRow = (purchaseId: string, over: Partial<SampleRecord> = {}): SampleRecord => ({
  id: `sample-${purchaseId}`,
  purchaseId,
  indices: [0, 1],
  verdict: "buy",
  reason: "fits",
  confidence: 0.9,
  createdAt: NOW,
  ...over,
});

describe("purchase flow: steps 4 to 7", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  let seq = 0;
  beforeAll(async () => {
    handle = await testDatabase();
    await fixtureMissionAndResource(handle.repos);
  });
  afterAll(() => handle.close());

  async function proposed() {
    const n = ++seq;
    const r = await handle.repos.resources.insert({ ...(await handle.repos.resources.getById("resource-1"))!, id: `resource-f${n}`, manifestHash: b32(200 + n) });
    const { purchase } = await createPurchaseService(handle.db).propose({
      purchase: purchaseInput({ id: `pf${n}`, resourceId: r.id, orderIdBytes32: b32(2000 + n), idempotencyKey: `k-pf${n}` }),
      reason: "t",
      source: { kind: "oracle", reference: "t" },
      simulated: true,
    });
    return purchase;
  }

  function flowWith(adapter: PaymentAdapter | undefined, judgment: (purchaseId: string) => Promise<SampleJudgment>) {
    const bus = createActivityBus();
    const judgeCalls: string[] = [];
    const judge: SampleJudge = {
      cached: () => undefined,
      judge: (id) => {
        judgeCalls.push(id);
        return judgment(id);
      },
    };
    const exceptions = createExceptionService({ db: handle.db, treasury: TREASURY, bus });
    const flow = createPurchaseFlow({
      purchases: createPurchaseService(handle.db, { publish: (e) => bus.publish(e) }),
      repos: handle.repos,
      exceptions,
      judge,
      adapters: adapter ? { "overflow-facilitator": adapter } : {},
      policy: { allowlistedPayees: async () => [] },
    });
    return { flow, judgeCalls, exceptions };
  }

  const buy = async (id: string): Promise<SampleJudgment> => ({ outcome: "buy", sample: sampleRow(id) });

  it("buy -> RESERVED -> PAYMENT_PENDING -> tx hash appended; never ESCROW_FUNDED", async () => {
    const p = await proposed();
    const good = fakeAdapter((o) => quoteFor(o));
    const { flow, judgeCalls } = flowWith(good.adapter, buy);
    const r = await flow.runAuthorization(p.id, "req-1");
    expect(r.outcome).toBe("submitted");
    if (r.outcome !== "submitted") throw new Error("unreachable");
    expect(r.purchase.status).toBe("PAYMENT_PENDING");
    expect(r.purchase.authorizationDigest).toBe(b32(0xd1));
    expect(r.purchase.txHashes).toEqual([b32(0x77)]);
    expect(r.submission).toEqual({ outcome: "submitted", txHash: b32(0x77) });
    expect(r.sample?.id).toBe(`sample-${p.id}`);
    expect(judgeCalls).toEqual([p.id]);
    expect(good.calls).toEqual({ requirements: 1, prepare: 1, submit: 1 });
    const events = await handle.repos.activityEvents.listByPurchase(p.id);
    expect(events.map((e) => e.message.split(":")[0])).toEqual(["proposed 12000000 atomic USDC for resource " + p.resourceId, "PROPOSED -> RESERVED", "RESERVED -> PAYMENT_PENDING"]);
    expect(events.some((e) => e.kind === "escrow.funded")).toBe(false);
  });

  it("rejected submission -> REJECTED with the decoded revert; unknown -> PAYMENT_UNKNOWN", async () => {
    const p1 = await proposed();
    const rejected = fakeAdapter((o) => quoteFor(o), { outcome: "rejected", decodedRevert: "OverBudget(3)" });
    const r1 = await flowWith(rejected.adapter, buy).flow.runAuthorization(p1.id, "req");
    expect(r1.purchase.status).toBe("REJECTED");
    const last1 = (await handle.repos.activityEvents.listByPurchase(p1.id)).at(-1)!;
    expect(last1).toMatchObject({ kind: "policy.blocked", decodedRevert: "OverBudget(3)" });

    const p2 = await proposed();
    const unknown = fakeAdapter((o) => quoteFor(o), { outcome: "unknown", error: "socket hang up" });
    const r2 = await flowWith(unknown.adapter, buy).flow.runAuthorization(p2.id, "req");
    expect(r2.purchase.status).toBe("PAYMENT_UNKNOWN");
    expect(r2.purchase.authorizationDigest).toBe(b32(0xd1));
  });

  it("step 5: a quote that disagrees with the order is REJECTED with QuoteMismatch(<field>) and never signed", async () => {
    const p = await proposed();
    const evil = fakeAdapter((o) => quoteFor(o, { payTo: ATTACKER }));
    const { flow } = flowWith(evil.adapter, buy);
    await expect(flow.runAuthorization(p.id, "req-q")).rejects.toBeInstanceOf(QuoteMismatchError);
    expect(evil.calls).toEqual({ requirements: 1, prepare: 0, submit: 0 });
    const row = (await handle.repos.purchases.getById(p.id))!;
    expect(row.status).toBe("REJECTED");
    expect(row.authorizationDigest).toBeUndefined();
    const last = (await handle.repos.activityEvents.listByPurchase(p.id)).at(-1)!;
    expect(last).toMatchObject({ kind: "policy.blocked", decodedRevert: "QuoteMismatch(payTo)", simulated: true });
    expect(last.message).toMatch(/^PROPOSED -> REJECTED: quote refused, not signed: quote mismatch on payTo.*\[api:req-q\]/);
  });

  it("no adapter for the path refuses with NotWiredError before sampling", async () => {
    const p = await proposed();
    const { flow, judgeCalls } = flowWith(undefined, buy);
    await expect(flow.runAuthorization(p.id, "req")).rejects.toBeInstanceOf(NotWiredError);
    expect(judgeCalls).toEqual([]);
    expect((await handle.repos.purchases.getById(p.id))!.status).toBe("PROPOSED");
  });

  it("held: the judge's exception stops the flow before the quote; an open exception refuses the next run", async () => {
    const p = await proposed();
    const good = fakeAdapter((o) => quoteFor(o));
    const sample = await handle.repos.samples.insert(sampleRow(p.id, { id: undefined as unknown as string, confidence: 0.3 }));
    const { flow, exceptions, judgeCalls } = flowWith(good.adapter, async () => {
      const raised = await exceptions.raise({ type: "LOW_CONFIDENCE_SAMPLE", requestedBy: "system:oracle", reason: "thin", purchaseId: p.id, sampleId: sample.id, confidence: 0.3 });
      return { outcome: "held", sample, exceptionId: raised.exception.id };
    });
    const r = await flow.runAuthorization(p.id, "req");
    expect(r.outcome).toBe("held");
    if (r.outcome !== "held") throw new Error("unreachable");
    expect(r.purchase.status).toBe("PROPOSED");
    expect(good.calls).toEqual({ requirements: 0, prepare: 0, submit: 0 });

    const again = flow.runAuthorization(p.id, "req-2");
    await expect(again).rejects.toBeInstanceOf(SampleHeldError);
    await expect(again).rejects.toMatchObject({ exceptionId: r.exceptionId, sampleId: sample.id });
    expect(judgeCalls).toEqual([p.id]);

    // The controller approves: the flow proceeds on the stored sample without asking the judge again.
    await exceptions.decide(r.exceptionId, { decidedBy: "owner", decision: "approve", reason: "looked at the rows myself" });
    const after = await flow.runAuthorization(p.id, "req-3");
    expect(after.outcome).toBe("submitted");
    expect(after.sample?.id).toBe(sample.id);
    expect(after.purchase.status).toBe("PAYMENT_PENDING");
    expect(judgeCalls).toEqual([p.id]);
    expect(good.calls).toEqual({ requirements: 1, prepare: 1, submit: 1 });
  });

  it("a rejected low-confidence exception ends the purchase before funding", async () => {
    const p = await proposed();
    const good = fakeAdapter((o) => quoteFor(o));
    const sample = await handle.repos.samples.insert(sampleRow(p.id, { id: undefined as unknown as string, confidence: 0.2 }));
    const { flow, exceptions, judgeCalls } = flowWith(good.adapter, buy);
    const raised = await exceptions.raise({ type: "LOW_CONFIDENCE_SAMPLE", requestedBy: "system:oracle", reason: "thin", purchaseId: p.id, sampleId: sample.id, confidence: 0.2 });
    await exceptions.decide(raised.exception.id, { decidedBy: "owner", decision: "reject", reason: "wrong market" });
    const run = flow.runAuthorization(p.id, "req-r");
    await expect(run).rejects.toBeInstanceOf(SampleRefusedError);
    await expect(run).rejects.toMatchObject({ kind: "declined", sample: { id: sample.id } });
    expect(judgeCalls).toEqual([]);
    expect(good.calls.requirements).toBe(0);
    const row = (await handle.repos.purchases.getById(p.id))!;
    expect(row.status).toBe("FAILED_BEFORE_FUNDING");
    const last = (await handle.repos.activityEvents.listByPurchase(p.id)).at(-1)!;
    expect(last.message).toMatch(/controller declined the low-confidence sample .*wrong market.*\[api:req-r\]/);
  });

  it("skip and mismatch from the judge surface as SampleRefusedError and sign nothing", async () => {
    const p1 = await proposed();
    const good = fakeAdapter((o) => quoteFor(o));
    const skip = flowWith(good.adapter, async (id) => ({ outcome: "skip", sample: sampleRow(id, { verdict: "skip" }), reason: "off topic" }));
    await expect(skip.flow.runAuthorization(p1.id, "req")).rejects.toMatchObject({ name: "SampleRefusedError", kind: "skip", reason: "off topic" });
    const p2 = await proposed();
    const failed = flowWith(good.adapter, async () => ({ outcome: "failed", reason: "ciphertext does not match rootCipher" }));
    await expect(failed.flow.runAuthorization(p2.id, "req")).rejects.toMatchObject({ kind: "mismatch", sample: undefined });
    expect(good.calls.requirements).toBe(0);
  });
});
