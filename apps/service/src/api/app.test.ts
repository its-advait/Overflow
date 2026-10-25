import type { PaymentRequirements } from "@overflow/payment-client";
import type { PurchaseOrder } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPurchaseService } from "../orchestration/purchase-service.js";
import { ATTACKER, b32, fixtureMissionAndResource, purchaseInput, quoteFor, testDatabase, TREASURY } from "../test-db.js";
import { createApp } from "./app.js";
import type { PaymentAdapter } from "./ports.js";

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

    it("filters activity by kind, alone and together with an agent", async () => {
      await handle.repos.activityEvents.insert({ kind: "policy.blocked", message: "treasury refused 0.50 USDC for /premium-intel: PayeeNotAllowed(0) [simulation]", decodedRevert: "PayeeNotAllowed(0)", agentId: "agent-research" });
      await handle.repos.activityEvents.insert({ kind: "agent.tool_call", message: "agent-research called call_paid_api", agentId: "agent-research" });
      await handle.repos.activityEvents.insert({ kind: "policy.blocked", message: "SIMULATED attacker bypass: USDC refused transferWithAuthorization sent outside settle()", decodedRevert: "Error(FiatTokenV2: invalid signature)", simulated: true });
      const blocked = await json(await app.request("/api/activity?kind=policy.blocked"));
      expect(blocked.events.map((e: { decodedRevert?: string }) => e.decodedRevert)).toEqual(["Error(FiatTokenV2: invalid signature)", "PayeeNotAllowed(0)"]);
      const research = await json(await app.request("/api/activity?kind=policy.blocked&agentId=agent-research"));
      expect(research.events).toHaveLength(1);
      expect(research.events[0].decodedRevert).toBe("PayeeNotAllowed(0)");
      expect((await json(await app.request("/api/activity?agentId=agent-research"))).events).toHaveLength(2);
      expect((await app.request("/api/activity?kind=not.a.kind")).status).toBe(400);
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
      const p3 = (await handle.repos.purchases.getById("p3"))!;
      expect(p3.status).toBe("FAILED_BEFORE_FUNDING");
      expect(p3.authorizationDigest).toBeUndefined();
      const last = (await handle.repos.activityEvents.listByPurchase("p3")).at(-1)!;
      expect(last.message).toMatch(/quote refused, not signed: quote mismatch on payTo/);
      expect(last.simulated).toBe(true);
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

    it("GET /:id, and the controller records its Wallet MCP submission without changing status", async () => {
      const [req] = (await json(await app.request("/api/controller-requests"))).requests;
      expect((await app.request(`/api/controller-requests/${req.id}`)).status).toBe(200);
      expect((await app.request("/api/controller-requests/nope")).status).toBe(404);

      const sub = { requestId: "wmcp-req-1", approvalUrl: "https://wallet.coinbase.com/approve/wmcp-req-1", submittedBy: "controller:0xW" };
      const first = await post(`/api/controller-requests/${req.id}/submission`, sub);
      expect(first.status).toBe(200);
      const body = await json(first);
      expect(body.recorded).toBe(true);
      expect(body.request).toMatchObject({ id: req.id, status: "pending", submission: { ...sub, chain: "base-sepolia" } });
      expect(body.request.txHash).toBeUndefined();
      expect(typeof body.request.submission.submittedAt).toBe("string");

      // Same Wallet MCP request id: idempotent. A different one: refused, the first stays on file.
      expect((await json(await post(`/api/controller-requests/${req.id}/submission`, sub))).recorded).toBe(false);
      const dup = await post(`/api/controller-requests/${req.id}/submission`, { ...sub, requestId: "wmcp-req-2" });
      expect(dup.status).toBe(409);
      const dupBody = await json(dup);
      expect(dupBody.error.code).toBe("already_submitted");
      expect(dupBody.error.details.existing.requestId).toBe("wmcp-req-1");
      expect((await json(await app.request(`/api/controller-requests/${req.id}`))).submission.requestId).toBe("wmcp-req-1");
      expect((await post(`/api/controller-requests/${req.id}/submission`, { requestId: "x" })).status).toBe(400);
      expect((await post(`/api/controller-requests/${req.id}/submission`, { ...sub, approvalUrl: "not a url" })).status).toBe(400);

      const recent = await handle.repos.activityEvents.listRecent(1);
      expect(recent[0]!.kind).toBe("controller.submitted");
      // Still pending: nothing but the indexed event marks it done.
      expect((await json(await app.request("/api/controller-requests?status=done"))).requests).toEqual([]);
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
      expect(all.exceptions.map((e: { type: string }) => e.type).sort()).toEqual(["PAUSE_REQUEST", "UNCLEAR_LICENSE"]);
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

    it("POST /api/exceptions raises an onchain exception with its prepared request; a repeat returns the open one", async () => {
      const payee = "0x5555555555555555555555555555555555555555";
      const res = await post("/api/exceptions", { type: "NEW_PAYEE", requestedBy: "agent-research", reason: "seller not allowlisted (SIMULATED payee)", payee });
      expect(res.status).toBe(202);
      const body = await json(res);
      expect(body.created).toBe(true);
      expect(body.exception).toMatchObject({ type: "NEW_PAYEE", status: "open", subject: `payee:${payee}` });
      expect(body.request).toMatchObject({ status: "pending", target: TREASURY, value: "0", action: { kind: "set-allow", payee, allowed: true } });
      expect(body.request.summary).toMatch(/^setAllow\(/);
      const again = await post("/api/exceptions", { type: "NEW_PAYEE", requestedBy: "agent-research", reason: "again", payee });
      expect(again.status).toBe(200);
      expect((await json(again))).toMatchObject({ created: false, exception: { id: body.exception.id } });
      const cap = await post("/api/exceptions", { type: "CAP_RAISE", requestedBy: "agent-orchestrator", reason: "over budget", nodeId: 1, newCapAtomic: "60000000" });
      expect(cap.status).toBe(202);
      const capBody = await json(cap);
      expect(capBody.request.summary).toMatch(/^raiseCap\(1, 60000000/);
      expect((await post("/api/exceptions", { type: "CAP_RAISE", requestedBy: "a", reason: "r", nodeId: 1, newCapAtomic: "1.5" })).status).toBe(400);
      expect((await post("/api/exceptions", { type: "NOPE", requestedBy: "a", reason: "r" })).status).toBe(400);
      // Only the indexed event can approve these; the controller rejects them here so no request lingers.
      for (const id of [body.exception.id, capBody.exception.id]) {
        expect((await post(`/api/exceptions/${id}/decide`, { decidedBy: "owner", decision: "reject", reason: "test cleanup" })).status).toBe(200);
      }
      expect((await json(await app.request("/api/controller-requests"))).requests).toEqual([]);
    });
  });
});
