import type { PaymentRequirements } from "@overflow/payment-client";
import type { Address, PurchaseOrder } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPurchaseService } from "../orchestration/purchase-service.js";
import type { SampleJudge } from "../orchestration/sample-judgment.js";
import { fakeModel, fakeSeller } from "../orchestration/sample-judgment.test-util.js";
import { ATTACKER, b32, fixtureMissionAndResource, NOW, purchaseInput, quoteFor, SELLER, testDatabase, TREASURY } from "../test-db.js";
import { createApp } from "./app.js";
import type { PaymentAdapter } from "./ports.js";

/** SIMULATED step 4: every purchase passes the sample with a fixed verdict; nothing is fetched or asked of a model. */
function fakeJudge(): SampleJudge {
  return {
    cached: () => undefined,
    judge: async (purchaseId) => ({
      outcome: "buy",
      sample: { id: `sample-${purchaseId}`, purchaseId, indices: [0], verdict: "buy", reason: "fake sample: fits", confidence: 1, createdAt: NOW },
    }),
  };
}

const JSON_HEADERS = { "content-type": "application/json" };
// Response bodies are untyped JSON in these tests; every 2xx body was already parsed by its Zod response schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** SIMULATED adapter: records calls, returns a fixed digest, never touches a chain. */
function fakeAdapter(quote: (order: PurchaseOrder) => PaymentRequirements) {
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
      return { outcome: "submitted", txHash: b32(0x77) };
    },
    async reconcilePayment() {
      return { status: "unknown" };
    },
  };
  return { adapter, calls };
}

describe("REST API", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  let good: ReturnType<typeof fakeAdapter>;
  let app: ReturnType<typeof createApp>["app"];
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });

  beforeAll(async () => {
    handle = await testDatabase();
    await fixtureMissionAndResource(handle.repos);
    good = fakeAdapter((o) => quoteFor(o));
    app = createApp({
      db: handle.db,
      ports: { adapters: { "overflow-facilitator": good.adapter } },
      sampleJudge: fakeJudge(),
      session: { organizationId: "org-demo", principal: "owner", ownerAddress: null },
      treasury: TREASURY,
    }).app;
  });
  afterAll(() => handle.close());

  describe("validation", () => {
    it("rejects a mission budget that is not integer atomic units", async () => {
      for (const budgetAtomic of ["1.5", 1.5, "-3", ""]) {
        const res = await post("/api/missions", { goal: "g", budgetAtomic, rootNodeId: 1 });
        expect(res.status).toBe(400);
        const body = await json(res);
        expect(body.error.code).toBe("validation_error");
        expect(body.error.details[0].path).toEqual(["budgetAtomic"]);
      }
    });

    it("rejects a non-JSON body and a bad query parameter", async () => {
      const bad = await app.request("/api/missions", { method: "POST", headers: JSON_HEADERS, body: "{not json" });
      expect(bad.status).toBe(400);
      expect((await json(bad)).error.code).toBe("invalid_json");
      const q = await app.request("/api/activity?limit=abc");
      expect(q.status).toBe(400);
      expect((await json(q)).error.code).toBe("validation_error");
    });

    it("creates a mission with an explicit root node and refuses one without any root", async () => {
      const ok = await post("/api/missions", { goal: "Find EV data", budgetAtomic: "20000000", rootNodeId: 1 });
      expect(ok.status).toBe(201);
      const { mission } = await json(ok);
      expect(mission.status).toBe("draft");
      expect(mission.organizationId).toBe("org-demo");
      const none = await post("/api/missions", { goal: "x", budgetAtomic: "1" });
      expect(none.status).toBe(409);
      expect((await json(none)).error.code).toBe("no_root_node");
    });
  });

  describe("unconfigured ports refuse, never fake success", () => {
    it("plan without a model is 503; propose without requests is 409", async () => {
      const plan = await post("/api/missions/mission-1/plan", {});
      expect(plan.status).toBe(503);
      expect((await json(plan)).error.code).toBe("oracle_unavailable");
      expect((await handle.repos.missions.getById("mission-1"))!.status).toBe("active");
      const propose = await post("/api/purchases/propose", { missionId: "mission-1" });
      expect(propose.status).toBe(409);
      expect((await json(propose)).error.code).toBe("no_open_requests");
    });

    it("reconciliation reports no run, and an on-demand run without a chain reader is 501", async () => {
      const res = await app.request("/api/reconciliation");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.lastRun).toBeNull();
      expect(body.openExceptions).toEqual([]);
      expect(body.note).toMatch(/no reconciliation run/);
      const run = await post("/api/reconciliation/run", {});
      expect(run.status).toBe(501);
      expect((await json(run)).error.code).toBe("not_wired");
    });
  });

  describe("reads", () => {
    it("resources, agents tree, ledger, activity", async () => {
      const r = await app.request("/api/resources");
      expect(r.status).toBe(200);
      const { resources, filtered } = await json(r);
      expect(resources[0].simulated).toBe(true);
      expect(filtered).toBe(false);

      const a = await app.request("/api/agents");
      const { tree, agents } = await json(a);
      expect(agents).toHaveLength(3);
      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe("agent-orchestrator");
      expect(tree[0].children.map((c: { id: string }) => c.id).sort()).toEqual(["agent-finance", "agent-research"]);
      expect(tree[0].node).toBeNull();

      const l = await app.request("/api/ledger");
      const ledger = await json(l);
      expect(ledger.entries).toEqual([]);
      expect(ledger.balances.find((b: { account: string }) => b.account === "usdc-treasury")).toEqual({
        account: "usdc-treasury",
        debitsAtomic: "0",
        creditsAtomic: "0",
        netAtomic: "0",
      });
      expect(ledger.departments).toEqual([]);
      expect((await app.request("/api/ledger?limit=0")).status).toBe(400);

      const act = await app.request("/api/activity?limit=5");
      expect(act.status).toBe(200);
    });

    it("has no /api/execute and no unknown routes", async () => {
      const res = await post("/api/execute", { to: ATTACKER, data: "0xdeadbeef" });
      expect(res.status).toBe(404);
      expect((await json(res)).error.code).toBe("route_not_found");
    });
  });

  describe("POST /api/purchases/:id/authorize", () => {
    const service = () => createPurchaseService(handle.db);

    it("requires an Idempotency-Key", async () => {
      await service().propose({ purchase: purchaseInput({ id: "p1" }), reason: "r", source: { kind: "oracle", reference: "t" } });
      const res = await post("/api/purchases/p1/authorize", {});
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe("idempotency_key_required");
      expect(good.calls.requirements).toBe(0);
    });

    it("authorizes once; a repeat key replays the same result without calling the adapter again", async () => {
      const first = await post("/api/purchases/p1/authorize", {}, { "Idempotency-Key": "auth-1" });
      expect(first.status).toBe(202);
      const body1 = await json(first);
      expect(body1.purchase.status).toBe("PAYMENT_PENDING");
      expect(body1.purchase.authorizationDigest).toBe(b32(0xd1));
      expect(body1.purchase.txHashes).toEqual([b32(0x77)]);
      expect(body1.submission).toEqual({ outcome: "submitted", txHash: b32(0x77) });
      expect(body1.sample).toEqual({ id: "sample-p1", verdict: "buy", confidence: 1, reason: "fake sample: fits" });
      expect(body1.replayed).toBe(false);
      expect(good.calls).toEqual({ requirements: 1, prepare: 1, submit: 1 });

      const events = await handle.repos.activityEvents.listByPurchase("p1");
      expect(events.map((e) => e.kind)).toEqual(["purchase.proposed", "payment.authorized", "payment.authorized"]);
      expect(events[1]!.message).toMatch(/^PROPOSED -> RESERVED/);
      expect(events[2]!.message).toMatch(/^RESERVED -> PAYMENT_PENDING/);
      // Funding is never claimed by the API.
      expect(events.some((e) => e.kind === "escrow.funded")).toBe(false);

      const repeat = await post("/api/purchases/p1/authorize", {}, { "Idempotency-Key": "auth-1" });
      expect(repeat.status).toBe(202);
      const body2 = await json(repeat);
      expect(body2.replayed).toBe(true);
      expect({ ...body2, replayed: false }).toEqual(body1);
      expect(good.calls).toEqual({ requirements: 1, prepare: 1, submit: 1 });
    });

    it("refuses the same key for a different request, and a new key hits the state machine", async () => {
      const reused = await post("/api/purchases/p1/authorize", { note: "different" }, { "Idempotency-Key": "auth-1" });
      expect(reused.status).toBe(422);
      expect((await json(reused)).error.code).toBe("idempotency_key_reused");

      const again = await post("/api/purchases/p1/authorize", {}, { "Idempotency-Key": "auth-2" });
      expect(again.status).toBe(409);
      const body = await json(again);
      expect(body.error.code).toBe("invalid_transition");
      expect(body.error.details).toEqual({ from: "PAYMENT_PENDING", to: "RESERVED" });
      expect(good.calls.prepare).toBe(1);
    });

    it("an illegal transition is refused and writes no event", async () => {
      const r2 = await handle.repos.resources.insert({
        ...(await handle.repos.resources.getById("resource-1"))!,
        id: "resource-2",
        manifestHash: b32(6),
      });
      await service().propose({
        purchase: purchaseInput({ id: "p2", resourceId: r2.id, orderIdBytes32: b32(2), idempotencyKey: "k-p2" }),
        reason: "r",
        source: { kind: "oracle", reference: "t" },
      });
      await service().transition("p2", "REJECTED", {
        reason: "planted",
        source: { kind: "adapter", reference: "overflow-facilitator" },
        decodedRevert: "PayeeNotAllowed(0)",
      });
      const before = (await handle.repos.activityEvents.listByPurchase("p2")).length;
      const res = await post("/api/purchases/p2/authorize", {}, { "Idempotency-Key": "auth-p2" });
      expect(res.status).toBe(409);
      expect((await json(res)).error.details).toEqual({ from: "REJECTED", to: "RESERVED" });
      expect((await handle.repos.activityEvents.listByPurchase("p2")).length).toBe(before);
      expect(good.calls.requirements).toBe(1);
    });

    it("a quote that pays someone other than the escrow is never signed (planted error 19)", async () => {
      const r3 = await handle.repos.resources.insert({
        ...(await handle.repos.resources.getById("resource-1"))!,
        id: "resource-3",
        manifestHash: b32(8),
      });
      const evil = fakeAdapter((o) => quoteFor(o, { payTo: ATTACKER }));
      const { app: app2 } = createApp({
        db: handle.db,
        ports: { adapters: { "overflow-facilitator": evil.adapter } },
        sampleJudge: fakeJudge(),
        session: { organizationId: "org-demo", principal: "owner", ownerAddress: null },
      });
      await service().propose({
        purchase: purchaseInput({ id: "p3", resourceId: r3.id, orderIdBytes32: b32(3), idempotencyKey: "k-p3" }),
        reason: "r",
        source: { kind: "oracle", reference: "t" },
      });
      const res = await app2.request("/api/purchases/p3/authorize", {
        method: "POST",
        headers: { ...JSON_HEADERS, "Idempotency-Key": "auth-p3" },
        body: "{}",
      });
      expect(res.status).toBe(409);
      const body = await json(res);
      expect(body.error.code).toBe("quote_mismatch");
      expect(body.error.details.field).toBe("payTo");
      expect(evil.calls).toEqual({ requirements: 1, prepare: 0, submit: 0 });
      // REJECTED with a decoded reason so it shows in the Blocked lane; the quote was never signed.
      const p3 = (await handle.repos.purchases.getById("p3"))!;
      expect(p3.status).toBe("REJECTED");
      expect(p3.authorizationDigest).toBeUndefined();
      const last = (await handle.repos.activityEvents.listByPurchase("p3")).at(-1)!;
      expect(last.kind).toBe("policy.blocked");
      expect(last.decodedRevert).toBe("QuoteMismatch(payTo)");
      expect(last.message).toMatch(/quote refused, not signed: quote mismatch on payTo/);
      expect(last.simulated).toBe(true);
    });

    it("answers 501 when no sample judge is wired (never signs without a sample)", async () => {
      const bare = createApp({ db: handle.db, ports: { adapters: { "overflow-facilitator": good.adapter } }, session: { organizationId: "org-demo", principal: "owner", ownerAddress: null } });
      const r5 = await handle.repos.resources.insert({ ...(await handle.repos.resources.getById("resource-1"))!, id: "resource-5", manifestHash: b32(11) });
      await service().propose({ purchase: purchaseInput({ id: "p5", resourceId: r5.id, orderIdBytes32: b32(5), idempotencyKey: "k-p5" }), reason: "r", source: { kind: "oracle", reference: "t" } });
      const res = await bare.app.request("/api/purchases/p5/authorize", { method: "POST", headers: { ...JSON_HEADERS, "Idempotency-Key": "auth-p5" }, body: "{}" });
      expect(res.status).toBe(501);
      expect((await json(res)).error.code).toBe("not_wired");
      expect((await handle.repos.purchases.getById("p5"))!.status).toBe("PROPOSED");
      expect(good.calls.requirements).toBe(1);
    });

    it("answers 501 when no adapter is registered for the order's path", async () => {
      const r4 = await handle.repos.resources.insert({
        ...(await handle.repos.resources.getById("resource-1"))!,
        id: "resource-4",
        manifestHash: b32(10),
      });
      await service().propose({
        purchase: purchaseInput({ id: "p4", resourceId: r4.id, orderIdBytes32: b32(4), idempotencyKey: "k-p4", paymentPath: "coinbase-facilitator" }),
        reason: "r",
        source: { kind: "oracle", reference: "t" },
      });
      const res = await post("/api/purchases/p4/authorize", {}, { "Idempotency-Key": "auth-p4" });
      expect(res.status).toBe(501);
      expect((await json(res)).error.code).toBe("not_wired");
      expect((await handle.repos.purchases.getById("p4"))!.status).toBe("PROPOSED");
    });

    it("GET /api/purchases/:id and /api/escrow/:id", async () => {
      const res = await app.request("/api/purchases/p1");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.purchase.id).toBe("p1");
      expect(body.escrow).toBeNull();
      expect(body.activity).toHaveLength(3);
      expect((await app.request("/api/purchases/nope")).status).toBe(404);
      expect((await app.request("/api/escrow/p1")).status).toBe(404);
    });
  });

  describe("POST /api/purchases/:id/authorize with the real sample judge (SIMULATED seller, scripted model)", () => {
    const seller = fakeSeller();
    let seq = 0;
    const service = () => createPurchaseService(handle.db);

    /** App wired like index.ts would: seller URL + in-process fetch + model; one purchase per SIMULATED order. */
    async function setup(script: Parameters<typeof fakeModel>[0], swapIndex?: number) {
      const n = ++seq;
      const model = fakeModel(script);
      const adapter = fakeAdapter((o) => quoteFor(o));
      const api = createApp({
        db: handle.db,
        ports: { adapters: { "overflow-facilitator": adapter.adapter } },
        oracle: model.model,
        sellerUrl: seller.sellerUrl,
        sellerFetch: seller.fetch,
        sampleSize: 6, // every chunk of the 6-row SIMULATED order, so the swapped chunk is always sampled (deterministic, no 1-in-3 miss)
        sampleConfidenceMin: 0.7,
        session: { organizationId: "org-demo", principal: "owner", ownerAddress: null },
        treasury: TREASURY,
      });
      const resource = await handle.repos.resources.insert({ ...(await handle.repos.resources.getById("resource-1"))!, id: `resource-j${n}`, manifestHash: b32(300 + n) });
      const orderId = b32(3000 + n);
      const escrowAddress = `0x${(0x7000 + n).toString(16).padStart(40, "0")}` as Address;
      const order = seller.addOrder({ orderId, resourceId: resource.id, buyer: TREASURY, seller: SELLER, escrowAddress, swapIndex });
      const id = `pj${n}`;
      await service().propose({
        purchase: purchaseInput({ id, resourceId: resource.id, orderIdBytes32: orderId, idempotencyKey: `k-${id}`, escrowAddress }),
        escrow: order.escrow,
        reason: "r",
        source: { kind: "oracle", reference: "t" },
        simulated: true,
      });
      const authorize = (key: string) => api.app.request(`/api/purchases/${id}/authorize`, { method: "POST", headers: { ...JSON_HEADERS, "Idempotency-Key": key }, body: "{}" });
      return { id, api, model, adapter, authorize };
    }

    it("held: 202 outcome held, exception row, status PROPOSED; a second authorize is 409; approval proceeds on the stored sample", async () => {
      const t = await setup([{ verdict: "buy", reason: "looks like US EV data but only four rows", confidence: 0.45 }]);
      const res = await t.authorize("h-1");
      expect(res.status).toBe(202);
      const body = await json(res);
      expect(body.submission.outcome).toBe("held");
      expect(body.authorizationDigest).toBeUndefined();
      expect(body.purchase.status).toBe("PROPOSED");
      expect(body.sample).toMatchObject({ verdict: "buy", confidence: 0.45, reason: "looks like US EV data but only four rows" });
      const exception = (await handle.repos.exceptions.getById(body.submission.exceptionId))!;
      expect(exception).toMatchObject({ type: "LOW_CONFIDENCE_SAMPLE", status: "open", purchaseId: t.id, requestedBy: "system:oracle" });
      expect(exception.details).toMatchObject({ sampleId: body.sample.id, confidence: 0.45 });
      expect(t.adapter.calls).toEqual({ requirements: 0, prepare: 0, submit: 0 });
      expect(t.model.calls).toBe(1);

      const again = await t.authorize("h-2");
      expect(again.status).toBe(409);
      const err = (await json(again)).error;
      expect(err.code).toBe("sample_low_confidence");
      expect(err.details).toMatchObject({ exceptionId: exception.id, sampleId: body.sample.id });
      expect(t.model.calls).toBe(1);

      const decide = await t.api.app.request(`/api/exceptions/${exception.id}/decide`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ decidedBy: "owner", decision: "approve", reason: "the rows are the right market" }),
      });
      expect(decide.status).toBe(200);
      const after = await t.authorize("h-3");
      expect(after.status).toBe(202);
      const body3 = await json(after);
      expect(body3.submission).toEqual({ outcome: "submitted", txHash: b32(0x77) });
      expect(body3.purchase.status).toBe("PAYMENT_PENDING");
      expect(body3.sample.id).toBe(body.sample.id);
      // One sample row, one model call for the whole episode.
      expect(await handle.repos.samples.listByPurchase(t.id)).toHaveLength(1);
      expect(t.model.calls).toBe(1);
      expect(t.adapter.calls).toEqual({ requirements: 1, prepare: 1, submit: 1 });
    });

    it("skip: 409 sample_skipped and FAILED_BEFORE_FUNDING; nothing signed", async () => {
      const t = await setup([{ verdict: "skip", reason: "state-level US rows; the mission needs EU countries", confidence: 0.9 }]);
      const res = await t.authorize("s-1");
      expect(res.status).toBe(409);
      const err = (await json(res)).error;
      expect(err.code).toBe("sample_skipped");
      expect(err.details.reason).toMatch(/EU countries/);
      expect((await handle.repos.purchases.getById(t.id))!.status).toBe("FAILED_BEFORE_FUNDING");
      expect(t.adapter.calls).toEqual({ requirements: 0, prepare: 0, submit: 0 });
      const kinds = (await handle.repos.activityEvents.listByPurchase(t.id)).map((e) => e.kind);
      expect(kinds).toEqual(["purchase.proposed", "oracle.model_call", "oracle.sample", "purchase.status"]);
    });

    it("a swapped chunk is caught by code: 409 sample_skipped with no model call", async () => {
      const t = await setup([], 1);
      const res = await t.authorize("w-1");
      expect(res.status).toBe(409);
      const err = (await json(res)).error;
      expect(err.code).toBe("sample_skipped");
      expect(err.details.reason).toMatch(/decrypt-mismatch/);
      expect(t.model.calls).toBe(0);
      expect((await handle.repos.purchases.getById(t.id))!.status).toBe("FAILED_BEFORE_FUNDING");
    });

    it("without a model the judge answers 503 and the purchase stays PROPOSED", async () => {
      const t = await setup([]);
      const noModel = createApp({
        db: handle.db,
        ports: { adapters: { "overflow-facilitator": t.adapter.adapter } },
        sellerUrl: seller.sellerUrl,
        sellerFetch: seller.fetch,
        session: { organizationId: "org-demo", principal: "owner", ownerAddress: null },
      });
      const res = await noModel.app.request(`/api/purchases/${t.id}/authorize`, { method: "POST", headers: { ...JSON_HEADERS, "Idempotency-Key": "m-1" }, body: "{}" });
      expect(res.status).toBe(503);
      expect((await json(res)).error.code).toBe("oracle_unavailable");
      expect((await handle.repos.purchases.getById(t.id))!.status).toBe("PROPOSED");
    });
  });

  describe("POST /api/agents/:id/pause", () => {
    it("refuses when the agent has no onchain node yet", async () => {
      const res = await post("/api/agents/agent-research/pause", { reason: "demo" });
      expect(res.status).toBe(409);
      expect((await json(res)).error.code).toBe("no_node_yet");
      expect(await handle.repos.controllerRequests.listPending()).toEqual([]);
    });

    it("creates a pending ControllerRequest and flips no local flag", async () => {
      await handle.repos.agents.setNodeId("agent-research", 2);
      const res = await post("/api/agents/agent-research/pause", { reason: "suspicious listing" });
      expect(res.status).toBe(202);
      const { request, exception } = await json(res);
      expect(request.status).toBe("pending");
      expect(request.action).toEqual({ kind: "pause", nodeId: 2 });
      expect(request.requestedBy).toBe("owner");
      expect(request.txHash).toBeUndefined();
      expect(request).toMatchObject({ target: TREASURY, value: "0", exceptionId: exception.id });
      expect(request.data).toBe("0x136439dd0000000000000000000000000000000000000000000000000000000000000002"); // pause(2)
      expect(exception).toMatchObject({ type: "PAUSE_REQUEST", status: "open", requestedBy: "owner", subject: "node:2:pause" });

      const pending = await handle.repos.controllerRequests.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).toBe(request.id);
      const recent = await handle.repos.activityEvents.listRecent(1);
      expect(recent[0]!.kind).toBe("controller.requested");
      expect(recent[0]!.agentId).toBe("agent-research");

      // The agents read model has no paused field at all; the tree still shows node: null.
      const tree = await json(await app.request("/api/agents"));
      expect(JSON.stringify(tree)).not.toContain("paused");
      expect((await post("/api/agents/agent-research/pause", {})).status).toBe(400);
      expect((await post("/api/agents/ghost/pause", { reason: "x" })).status).toBe(404);
    });
  });

  describe("exceptions and controller requests", () => {
    let licenseId: string;

    it("lists open exceptions with their prepared request; controller requests are read-only", async () => {
      const res = await app.request("/api/exceptions");
      expect(res.status).toBe(200);
      const { exceptions } = await json(res);
      expect(exceptions).toHaveLength(1); // the pause above
      expect(exceptions[0].type).toBe("PAUSE_REQUEST");
      expect(exceptions[0].request).toMatchObject({ status: "pending", action: { kind: "pause", nodeId: 2 }, target: TREASURY });

      const cr = await app.request("/api/controller-requests");
      expect(cr.status).toBe(200);
      const body = await json(cr);
      expect(body.treasury).toBe(TREASURY);
      expect(body.requests).toHaveLength(1);
      expect(body.requests[0].id).toBe(exceptions[0].request.id);
      expect((await app.request("/api/controller-requests?status=done")).status).toBe(200);
      expect((await json(await app.request("/api/controller-requests?status=done"))).requests).toEqual([]);
      expect((await app.request("/api/controller-requests?status=approved")).status).toBe(400);
      // Nothing marks a request done over HTTP.
      expect((await post("/api/controller-requests/" + body.requests[0].id + "/done", {})).status).toBe(404);
    });

    it("an agent can't decide its own exception; the controller can, once, with who and why", async () => {
      const { deps } = createApp({ db: handle.db, session: { organizationId: "org-demo", principal: "owner", ownerAddress: null }, treasury: TREASURY });
      const raised = await deps.exceptions.raise({
        type: "UNCLEAR_LICENSE",
        requestedBy: "agent-research",
        reason: "license says 'internal use' but the mission shares results with a partner",
        resourceId: "resource-1",
        license: "unclear",
        agentId: "agent-research",
      });
      licenseId = raised.exception.id;

      const self = await post(`/api/exceptions/${licenseId}/decide`, { decidedBy: "agent-research", decision: "approve", reason: "I need it" });
      expect(self.status).toBe(403);
      expect((await json(self)).error.code).toBe("self_resolution");
      expect((await handle.repos.exceptions.getById(licenseId))!.status).toBe("open");

      expect((await post(`/api/exceptions/${licenseId}/decide`, { decidedBy: "owner", decision: "maybe", reason: "r" })).status).toBe(400);
      expect((await post(`/api/exceptions/${licenseId}/decide`, { decidedBy: "owner", decision: "approve" })).status).toBe(400);

      const ok = await post(`/api/exceptions/${licenseId}/decide`, { decidedBy: "owner", decision: "approve", reason: "legal confirmed partner sharing is covered" });
      expect(ok.status).toBe(200);
      const body = await json(ok);
      expect(body.exception).toMatchObject({
        status: "resolved",
        resolvedBy: "owner",
        decision: "approve",
        decisionReason: "legal confirmed partner sharing is covered",
      });
      expect(body.request).toBeNull();
      const recent = await handle.repos.activityEvents.listRecent(1);
      expect(recent[0]).toMatchObject({ kind: "controller.resolved", agentId: "agent-research" });

      const twice = await post(`/api/exceptions/${licenseId}/decide`, { decidedBy: "owner", decision: "reject", reason: "changed my mind" });
      expect(twice.status).toBe(409);
      expect((await json(twice)).error.code).toBe("already_decided");
      expect((await post("/api/exceptions/nope/decide", { decidedBy: "owner", decision: "approve", reason: "r" })).status).toBe(404);

      const all = await json(await app.request("/api/exceptions?status=all"));
      // The LOW_CONFIDENCE_SAMPLE row is the one the controller approved in the authorize tests above.
      expect(all.exceptions.map((e: { type: string }) => e.type).sort()).toEqual(["LOW_CONFIDENCE_SAMPLE", "PAUSE_REQUEST", "UNCLEAR_LICENSE"]);
      expect((await json(await app.request("/api/exceptions"))).exceptions.map((e: { type: string }) => e.type)).toEqual(["PAUSE_REQUEST"]);
    });

    it("approving an onchain exception over HTTP is refused; rejecting it rejects the request without a tx", async () => {
      const [pause] = (await json(await app.request("/api/exceptions"))).exceptions;
      const approve = await post(`/api/exceptions/${pause.id}/decide`, { decidedBy: "controller", decision: "approve", reason: "yes" });
      expect(approve.status).toBe(409);
      const err = (await json(approve)).error;
      expect(err.code).toBe("onchain_approval_required");
      expect(err.details.requestId).toBe(pause.request.id);
      expect((await handle.repos.controllerRequests.getById(pause.request.id))!.status).toBe("pending");

      const reject = await post(`/api/exceptions/${pause.id}/decide`, { decidedBy: "controller", decision: "reject", reason: "the listing checked out" });
      expect(reject.status).toBe(200);
      const body = await json(reject);
      expect(body.exception).toMatchObject({ status: "dismissed", resolvedBy: "controller", decision: "reject" });
      expect(body.request).toMatchObject({ status: "rejected" });
      expect(body.request.txHash).toBeUndefined();
      expect((await json(await app.request("/api/controller-requests"))).requests).toEqual([]);
      expect((await json(await app.request("/api/controller-requests?status=rejected"))).requests).toHaveLength(1);
    });
  });
});
