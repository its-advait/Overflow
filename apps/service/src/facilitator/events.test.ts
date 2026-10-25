import { describe, expect, it } from "vitest";
import { createBus, createLogPoller, logToEvent } from "./events";
import { fakeChain, makeApp, NOW, paidLog, PAYEE, TREASURY } from "./fakes.test-util";

const H = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as const;

describe("event bus and poller", () => {
  it("ring buffer caps at capacity and keeps order", () => {
    const bus = createBus({ capacity: 3, now: () => NOW });
    for (let i = 0; i < 5; i++) bus.publish({ kind: "Paid", source: "chain", args: { i: String(i) } });
    expect(bus.replay().map((e) => e.args!["i"])).toEqual(["2", "3", "4"]);
    expect(bus.replay().map((e) => e.seq)).toEqual([3, 4, 5]);
  });
  it("decodes a Paid log with explorer link and string args", () => {
    const e = logToEvent(paidLog(1n, PAYEE, 50000n, `0x${"ab".repeat(32)}`, H(1), 123n))!;
    expect(e).toMatchObject({ kind: "Paid", source: "chain", txHash: H(1), blockNumber: "123", args: { id: "1", to: PAYEE, value: "50000" } });
    expect(e.explorerUrl).toContain(H(1));
  });
  it("poller dedups by txHash+logIndex and advances the cursor", async () => {
    const chain = fakeChain();
    const bus = createBus({ now: () => NOW });
    chain.logs = [paidLog(1n, PAYEE, 1n, `0x${"01".repeat(32)}`, H(1)), paidLog(1n, PAYEE, 1n, `0x${"01".repeat(32)}`, H(1))];
    const p = createLogPoller({ client: chain, treasury: TREASURY, bus, fromBlock: 90n, intervalMs: 100000 });
    expect(await p.tick()).toBe(1);
    expect(await p.tick()).toBe(0); // head not advanced
    chain.head = 101n;
    chain.logs = [paidLog(2n, PAYEE, 1n, `0x${"02".repeat(32)}`, H(2))];
    expect(await p.tick()).toBe(1);
    expect(bus.replay()).toHaveLength(2);
    p.stop();
  });
  it("GET /events streams the replay then live events as SSE", async () => {
    const chain = fakeChain();
    const { app, bus } = makeApp(chain);
    bus.publish({ kind: "NodeCreated", source: "chain", args: { id: "1" } });
    const res = await app.request("/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
    };
    await readUntil("NodeCreated");
    bus.publish({ kind: "Reverted", source: "facilitator", route: "settle", decoded: { name: "Paused", args: ["1"], reason: "Agent 1 is paused", source: "treasury" } });
    await readUntil("Reverted");
    expect(text).toMatch(/event: NodeCreated\n/);
    expect(text).toMatch(/event: Reverted\n/);
    expect(text).toMatch(/"reason":"Agent 1 is paused"/);
    await readUntil(": hb");
    void reader.cancel().catch(() => undefined);
  });
});
