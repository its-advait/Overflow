import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { createActivityBus, type BusMessage } from "../chain/bus";
import { testDatabase, b32 } from "../test-db";
import { bridgeFacilitatorRefusals, bypassRefusalMessage, decodedRevertOf } from "./activity-bridge";
import { BYPASS_REASON } from "./decode";
import { createBus } from "./events";

const DIGEST = b32(0xd1);
const TX = b32(0xbb);
const usdcDecoded = { name: "Error", args: ["FiatTokenV2: invalid signature"], reason: BYPASS_REASON, source: "usdc" as const };

describe("facilitator -> activity bridge", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => {
    handle = await testDatabase();
  });
  afterAll(async () => {
    await handle.close();
  });

  const flush = () => new Promise((r) => setTimeout(r, 20));

  it("records a BypassRejected as a SIMULATED policy.blocked row with the USDC reason, the tx and the digest, and streams it", async () => {
    const facilitatorBus = createBus();
    const activityBus = createActivityBus();
    const streamed: BusMessage[] = [];
    activityBus.subscribe((m) => streamed.push(m));
    const logs: string[] = [];
    const stop = bridgeFacilitatorRefusals({ facilitatorBus, repos: handle.repos, activityBus, log: (m) => logs.push(m) });

    facilitatorBus.publish({ kind: "BypassRejected", source: "facilitator", route: "demo/bypass", digest: DIGEST, txHash: TX, simulated: true, decoded: usdcDecoded });
    await flush();

    const rows = await handle.repos.activityEvents.listRecent(10, { kind: "policy.blocked" });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.decodedRevert).toBe("Error(FiatTokenV2: invalid signature)");
    expect(row.txHash).toBe(TX);
    expect(row.simulated).toBe(true);
    expect(row.agentId).toBeUndefined();
    expect(row.message).toBe(`SIMULATED attacker bypass: USDC refused transferWithAuthorization sent outside settle(): ${BYPASS_REASON} [facilitator:${DIGEST}]`);
    expect(streamed).toEqual([{ type: "activity", event: row }]);
    expect(logs).toEqual([]);
    stop();
  });

  it("does not bridge Reverted (its caller records it) and only logs a BypassSucceeded", async () => {
    const facilitatorBus = createBus();
    const activityBus = createActivityBus();
    const logs: string[] = [];
    const before = (await handle.repos.activityEvents.listRecent(100)).length;
    const stop = bridgeFacilitatorRefusals({ facilitatorBus, repos: handle.repos, activityBus, log: (m) => logs.push(m) });
    facilitatorBus.publish({ kind: "Reverted", source: "facilitator", route: "settle", digest: b32(0xd2), decoded: { name: "PayeeNotAllowed", args: ["0"], reason: "Recipient is not approved for anyone", source: "treasury" } });
    facilitatorBus.publish({ kind: "BypassSucceeded", source: "facilitator", route: "demo/bypass", digest: b32(0xd3), txHash: b32(0xbc) as Hex, simulated: true });
    facilitatorBus.publish({ kind: "Paid", source: "chain", txHash: b32(0xbd) as Hex, args: { to: "0x" } });
    await flush();
    expect((await handle.repos.activityEvents.listRecent(100)).length).toBe(before);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/WARNING: SIMULATED bypass .* ACCEPTED by USDC/);
    stop();
    facilitatorBus.publish({ kind: "BypassRejected", source: "facilitator", route: "demo/bypass", digest: b32(0xd4), txHash: b32(0xbe) as Hex, simulated: true });
    await flush();
    expect((await handle.repos.activityEvents.listRecent(100)).length).toBe(before);
  });

  it("falls back to USDC's invalid-signature error when the bypass carried no decoded data", () => {
    expect(decodedRevertOf({})).toBe("Error(FiatTokenV2: invalid signature)");
    expect(decodedRevertOf({ decoded: { name: "PayeeNotAllowed", args: ["0"], reason: "x", source: "treasury" } })).toBe("PayeeNotAllowed(0)");
    expect(bypassRefusalMessage({})).toBe(`SIMULATED attacker bypass: USDC refused transferWithAuthorization sent outside settle(): ${BYPASS_REASON}`);
  });
});
