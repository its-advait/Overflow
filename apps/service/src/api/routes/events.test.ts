import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActivityBus } from "../../chain/bus.js";
import { fixtureMissionAndResource, purchaseInput, testDatabase } from "../../test-db.js";
import { createApp } from "../app.js";

interface Frame {
  event?: string;
  id?: string;
  data: string;
}

/** Reads SSE frames until `count` frames of the wanted events arrived. */
async function readFrames(res: Response, count: number, wanted = new Set(["activity", "indexer"])): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Frame[] = [];
  while (frames.filter((f) => wanted.has(f.event ?? "")).length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const frame: Frame = { data: "" };
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
        else if (line.startsWith("data:")) frame.data += line.slice(5).trim();
      }
      frames.push(frame);
    }
  }
  reader.cancel().catch(() => undefined);
  return frames;
}

describe("GET /events (SSE)", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  let api: ReturnType<typeof createApp>;
  const bus = createActivityBus();
  beforeAll(async () => {
    handle = await testDatabase();
    await fixtureMissionAndResource(handle.repos);
    api = createApp({ db: handle.db, bus, indexerStatus: () => ({ state: "idle", reason: "test: no indexer" }) });
    await api.deps.purchases.propose({ purchase: purchaseInput({ id: "s1" }), reason: "fixture", source: { kind: "oracle", reference: "t" } });
  });
  afterAll(() => handle.close());

  it("sends the indexer status, replays history, then streams live committed events", async () => {
    const ac = new AbortController();
    const res = await api.app.request("/events", { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const first = readFrames(res, 3); // indexer + 1 replayed + 1 live
    // Live event: a real transition through PurchaseService (committed before publish).
    await new Promise((r) => setTimeout(r, 20));
    const moved = await api.deps.purchases.transition("s1", "RESERVED", {
      reason: "signed",
      source: { kind: "adapter", reference: "t" },
      authorizationDigest: `0x${"d1".repeat(32)}`,
    });
    const frames = await first;
    ac.abort();

    expect(frames[0]).toMatchObject({ event: "indexer" });
    expect(JSON.parse(frames[0]!.data)).toEqual({ state: "idle", reason: "test: no indexer" });
    const activity = frames.filter((f) => f.event === "activity").map((f) => ({ id: f.id, body: JSON.parse(f.data) }));
    expect(activity[0]!.body).toMatchObject({ kind: "purchase.proposed", purchaseId: "s1" });
    expect(activity[0]!.id).toBe(activity[0]!.body.id);
    expect(activity[1]!.body).toMatchObject({ id: moved.event.id, kind: "payment.authorized", purchaseId: "s1" });
    expect(bus.listenerCount()).toBe(0); // unsubscribed on abort
  });

  it("Last-Event-ID replays only what came after it", async () => {
    const all = (await handle.repos.activityEvents.listRecent(10)).reverse();
    expect(all).toHaveLength(2);
    const ac = new AbortController();
    const res = await api.app.request("/events", { signal: ac.signal, headers: { "last-event-id": all[0]!.id } });
    const frames = await readFrames(res, 2);
    ac.abort();
    const activity = frames.filter((f) => f.event === "activity");
    expect(activity).toHaveLength(1);
    expect(activity[0]!.id).toBe(all[1]!.id);
  });

  it("rejects a malformed since parameter", async () => {
    const res = await api.app.request("/events?since=yesterday");
    expect(res.status).toBe(400);
  });
});
