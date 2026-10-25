import { encodeErrorResult } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPurchaseService } from "../orchestration/purchase-service.js";
import { b32, fixtureMissionAndResource, purchaseInput, testDatabase } from "../test-db.js";
import { treasuryAbi } from "./abi.js";
import { createActivityBus, type BusMessage } from "./bus.js";
import { recordFailedTransaction } from "./failed.js";

describe("recordFailedTransaction (Blocked lane)", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  const bus = createActivityBus();
  const published: BusMessage[] = [];
  let purchases: ReturnType<typeof createPurchaseService>;
  beforeAll(async () => {
    handle = await testDatabase();
    await fixtureMissionAndResource(handle.repos);
    purchases = createPurchaseService(handle.db, { publish: (e) => bus.publish(e) });
    bus.subscribe((m) => published.push(m));
    await purchases.propose({ purchase: purchaseInput({ id: "pf" }), reason: "fixture", source: { kind: "oracle", reference: "t" } });
  });
  afterAll(() => handle.close());

  it("rejects the named purchase with the decoded revert", async () => {
    const data = encodeErrorResult({ abi: treasuryAbi, errorName: "OverBudget", args: [3n] });
    const r = await recordFailedTransaction(
      { db: handle.db, purchases, bus },
      { purchaseId: "pf", error: { cause: { data } }, txHash: b32(0x99), source: { kind: "adapter", reference: "overflow-facilitator" } },
    );
    expect(r.decoded.decoded).toBe("OverBudget(3)");
    expect(r.purchase?.status).toBe("REJECTED");
    expect(r.event).toMatchObject({ kind: "policy.blocked", decodedRevert: "OverBudget(3)", txHash: b32(0x99), purchaseId: "pf" });
    expect(published.filter((m) => m.type === "activity" && m.event.id === r.event.id)).toHaveLength(1);
  });

  it("a failure with no (or a terminal) purchase is a standalone blocked event", async () => {
    const r = await recordFailedTransaction({ db: handle.db, purchases, bus }, { purchaseId: "pf", decodedRevert: "PayeeNotAllowed(0)" });
    expect(r.purchase?.status).toBe("REJECTED"); // unchanged
    expect(r.event).toMatchObject({ kind: "policy.blocked", decodedRevert: "PayeeNotAllowed(0)", purchaseId: "pf" });
    expect(r.event.message).toContain("Recipient isn't approved");
    const none = await recordFailedTransaction({ db: handle.db, purchases, bus }, { error: new Error("nonce too low") });
    expect(none.event.decodedRevert).toBe('Unknown("nonce too low")');
    expect(none.event.purchaseId).toBeUndefined();
  });
});
