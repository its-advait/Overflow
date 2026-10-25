import { readFileSync } from "node:fs";
import { encodeFunctionData } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotWiredError } from "../api/ports.js";
import { treasuryAbi } from "../chain/abi.js";
import { createActivityBus, type BusMessage } from "../chain/bus.js";
import type { RawLog } from "../chain/log-source.js";
import { fakeLogSource } from "../chain/fake-source.js";
import { FIXTURE } from "../chain/fixtures/build-fixture.js";
import { createIndexer } from "../chain/indexer.js";
import { ATTACKER, fixtureMissionAndResource, testDatabase } from "../test-db.js";
import { buildControllerCall } from "./calldata.js";
import { createExceptionService, OnchainApprovalRequiredError, SelfResolutionError, type ExceptionService } from "./service.js";

const fixture = JSON.parse(readFileSync(new URL("../chain/fixtures/base-sepolia-logs.json", import.meta.url), "utf8")) as { logs: RawLog[] };

describe("exceptions and controller requests (SIMULATED fixture)", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  let svc: ExceptionService;
  const bus = createActivityBus();
  const published: BusMessage[] = [];

  beforeAll(async () => {
    handle = await testDatabase();
    await fixtureMissionAndResource(handle.repos);
    bus.subscribe((m) => published.push(m));
    svc = createExceptionService({ db: handle.db, treasury: FIXTURE.treasury, bus });
  });
  afterAll(() => handle.close());

  describe("each type creates the right request", () => {
    it("NEW_PAYEE -> setAllow(payee, true) calldata on the treasury, pending, linked to the exception", async () => {
      const r = await svc.raise({ type: "NEW_PAYEE", requestedBy: "agent-research", reason: "seller is not on the allowlist", payee: FIXTURE.seller, agentId: "agent-research" });
      expect(r.created).toBe(true);
      expect(r.exception).toMatchObject({ type: "NEW_PAYEE", status: "open", requestedBy: "agent-research", subject: `payee:${FIXTURE.seller.toLowerCase()}` });
      expect(r.exception.details).toEqual({ payee: FIXTURE.seller, agentId: "agent-research" });
      expect(r.request).toMatchObject({
        status: "pending",
        exceptionId: r.exception.id,
        requestedBy: "agent-research",
        target: FIXTURE.treasury,
        value: "0",
        action: { kind: "set-allow", payee: FIXTURE.seller, allowed: true },
        data: encodeFunctionData({ abi: treasuryAbi, functionName: "setAllow", args: [FIXTURE.seller, true] }),
      });
      expect(r.request!.txHash).toBeUndefined();
      expect(r.request!.summary).toMatch(/^setAllow\(/);
      expect(r.events.map((e) => e.kind)).toEqual(["exception.opened", "controller.requested"]);
      expect(published.filter((m) => m.type === "activity").length).toBe(2);
    });

    it("CAP_RAISE -> raiseCap(nodeId, newCap); PAUSE_REQUEST -> pause(nodeId)", async () => {
      const cap = await svc.raise({ type: "CAP_RAISE", requestedBy: "agent-orchestrator", reason: "OverBudget(1) on the EV mission", nodeId: 1, newCapAtomic: FIXTURE.raisedCap, amountAtomic: "30000000" });
      expect(cap.request).toMatchObject({
        action: { kind: "raise-cap", nodeId: 1, newCapAtomic: FIXTURE.raisedCap },
        data: encodeFunctionData({ abi: treasuryAbi, functionName: "raiseCap", args: [1n, BigInt(FIXTURE.raisedCap)] }),
        target: FIXTURE.treasury,
        value: "0",
        status: "pending",
      });
      expect(cap.exception.amountAtomic).toBe("30000000");
      const pause = await svc.raise({ type: "PAUSE_REQUEST", requestedBy: "owner", reason: "suspicious listing", nodeId: 1, agentId: "agent-orchestrator" });
      expect(pause.request).toMatchObject({
        action: { kind: "pause", nodeId: 1 },
        data: encodeFunctionData({ abi: treasuryAbi, functionName: "pause", args: [1n] }),
        status: "pending",
      });
      expect(buildControllerCall({ kind: "pause", nodeId: 7 }, FIXTURE.treasury).data).toBe("0x136439dd0000000000000000000000000000000000000000000000000000000000000007");
      expect(() => buildControllerCall({ kind: "withdraw", to: ATTACKER, amountAtomic: "1" }, FIXTURE.treasury)).toThrow(/no calldata builder/);
    });

    it("UNCLEAR_LICENSE, LOW_CONFIDENCE_SAMPLE, DISPUTE_WITHOUT_PROOF open an exception and no request", async () => {
      const lic = await svc.raise({ type: "UNCLEAR_LICENSE", requestedBy: "agent-research", reason: "license text is ambiguous", resourceId: "resource-1", license: "unclear" });
      const smp = await svc.raise({ type: "LOW_CONFIDENCE_SAMPLE", requestedBy: "agent-research", reason: "oracle 0.41 confident", purchaseId: "p-none", sampleId: "s1", confidence: 0.41 }).catch((e: unknown) => e);
      const dsp = await svc.raise({ type: "DISPUTE_WITHOUT_PROOF", requestedBy: "agent-finance", reason: "seller delivered stale rows; no chain-checkable proof", purchaseId: "p-none" }).catch((e: unknown) => e);
      expect(lic.request).toBeUndefined();
      expect(lic.exception.details).toEqual({ resourceId: "resource-1", license: "unclear" });
      // purchaseId is a foreign key: a sample or dispute about an unknown purchase is refused, not stored.
      expect(smp).toBeInstanceOf(Error);
      expect(dsp).toBeInstanceOf(Error);
      expect(lic.events.map((e) => e.kind)).toEqual(["exception.opened"]);
      expect((await handle.repos.controllerRequests.list("all")).length).toBe(3);
    });

    it("the same subject is not raised twice; without a treasury an onchain type is refused and nothing is written", async () => {
      const before = (await handle.repos.exceptions.list("all")).length;
      const again = await svc.raise({ type: "NEW_PAYEE", requestedBy: "agent-finance", reason: "again", payee: FIXTURE.seller.toUpperCase().replace("0X", "0x") as `0x${string}` });
      expect(again.created).toBe(false);
      expect(again.exception.requestedBy).toBe("agent-research");
      expect(again.request?.action).toEqual({ kind: "set-allow", payee: FIXTURE.seller, allowed: true });
      expect((await handle.repos.exceptions.list("all")).length).toBe(before);

      const unwired = createExceptionService({ db: handle.db, treasury: null });
      await expect(unwired.raise({ type: "NEW_PAYEE", requestedBy: "agent-finance", reason: "x", payee: ATTACKER })).rejects.toBeInstanceOf(NotWiredError);
      expect((await handle.repos.exceptions.list("all")).length).toBe(before);
      // Offchain types still work without a treasury.
      const off = await unwired.raise({ type: "UNCLEAR_LICENSE", requestedBy: "agent-finance", reason: "x", resourceId: "resource-1", license: "unclear" });
      expect(off.created).toBe(false); // same subject as the one above
    });
  });

  describe("a request completes only when its event is indexed", () => {
    it("approving an onchain exception offchain is refused; the fixture's AllowSet/CapRaised/NodePaused mark the matching requests done", async () => {
      // One request whose event never comes: the attacker payee.
      const atk = await svc.raise({ type: "NEW_PAYEE", requestedBy: "agent-research", reason: "attacker (SIMULATED)", payee: ATTACKER });
      const open = await svc.list("open");
      const payee = open.find((e) => e.subject === `payee:${FIXTURE.seller.toLowerCase()}`)!;
      await expect(svc.decide(payee.id, { decidedBy: "owner", decision: "approve", reason: "ok" })).rejects.toBeInstanceOf(OnchainApprovalRequiredError);
      expect((await handle.repos.controllerRequests.getById(payee.request!.id))!.status).toBe("pending");
      expect((await handle.repos.exceptions.getById(payee.id))!.status).toBe("open");

      const source = fakeLogSource(fixture.logs, BigInt(FIXTURE.head));
      const indexer = createIndexer({
        db: handle.db,
        source,
        config: { chainId: 84532, rpcUrl: "http://fake.invalid", treasury: FIXTURE.treasury, escrowFactory: FIXTURE.factory, usdc: FIXTURE.usdc, deployBlock: FIXTURE.deployBlock, pollMs: 2000, reorgDepth: 12, chunkBlocks: 50 },
        bus,
        log: () => undefined,
        warn: () => undefined,
      });
      const tick = await indexer.tick();
      expect(tick.logsInserted).toBe(26);

      const done = await svc.listRequests("done");
      expect(done.map((r) => r.action.kind).sort()).toEqual(["pause", "raise-cap", "set-allow"]);
      const allowLog = fixture.logs.find((l) => l.blockNumber === "102" && l.logIndex === 0)!;
      const ownerLog = fixture.logs.find((l) => l.blockNumber === "110" && l.logIndex === 2)!;
      expect(done.find((r) => r.action.kind === "set-allow")!.txHash).toBe(allowLog.transactionHash);
      expect(done.find((r) => r.action.kind === "raise-cap")!.txHash).toBe(ownerLog.transactionHash);
      expect(done.find((r) => r.action.kind === "pause")!.txHash).toBe(ownerLog.transactionHash);
      for (const r of done) {
        const ex = (await handle.repos.exceptions.getById(r.exceptionId!))!;
        expect(ex).toMatchObject({ status: "resolved", resolvedBy: "chain", decision: "approve" });
        expect(ex.decisionReason).toMatch(new RegExp(`confirmed in ${r.txHash}$`));
      }
      const resolvedEvents = tick.events.filter((e) => e.kind === "controller.resolved");
      expect(resolvedEvents.length).toBe(3);
      expect(resolvedEvents.every((e) => e.txHash)).toBe(true);
      expect(published.some((m) => m.type === "activity" && m.event.kind === "controller.resolved")).toBe(true);

      // The attacker request saw no AllowSet: still pending, exception still open.
      expect((await handle.repos.controllerRequests.getById(atk.request!.id))!.status).toBe("pending");
      expect((await svc.listRequests("pending")).map((r) => r.id)).toEqual([atk.request!.id]);

      // Replaying the same logs changes nothing.
      const again = await indexer.tick();
      expect(again.logsInserted).toBe(0);
      expect(again.events.filter((e) => e.kind === "controller.resolved")).toEqual([]);
      expect((await svc.listRequests("done")).length).toBe(3);
    });

    it("the controller can reject an onchain request offchain: request rejected, exception dismissed, who and why recorded", async () => {
      const [atk] = await svc.listRequests("pending");
      await expect(svc.decide(atk!.exceptionId!, { decidedBy: "agent-research", decision: "reject", reason: "self" })).rejects.toBeInstanceOf(SelfResolutionError);
      const r = await svc.decide(atk!.exceptionId!, { decidedBy: "owner", decision: "reject", reason: "known attacker address (SIMULATED)" });
      expect(r.request).toMatchObject({ id: atk!.id, status: "rejected" });
      expect(r.request!.txHash).toBeUndefined();
      expect(r.exception).toMatchObject({ status: "dismissed", resolvedBy: "owner", decision: "reject", decisionReason: "known attacker address (SIMULATED)" });
      expect(await svc.listRequests("pending")).toEqual([]);
    });
  });
});
