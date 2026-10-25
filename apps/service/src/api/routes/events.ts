import { ActivityEventSchema, IsoDateTimeSchema } from "@overflow/schemas";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { IndexerStatusSchema, type BusMessage } from "../../chain/bus.js";
import type { ApiDeps } from "../deps.js";
import { parseQuery, type ApiEnv } from "../http.js";

// ---------------------------------------------------------------------------
// GET /events: Server-Sent Events of normalized activity.
//   event: indexer   data: IndexerStatus          (on connect, then on change)
//   event: activity  data: ActivityEvent  id: <id> (replay, then live)
// Every activity frame is a committed activity_events row, the same records
// GET /api/activity returns; nothing is synthesized for the stream.
// ---------------------------------------------------------------------------

const Query = z.object({
  /** Replay events strictly after this instant (alternative to Last-Event-ID). */
  since: IsoDateTimeSchema.optional(),
  /** Without a cursor, replay this many recent events (oldest first). */
  replay: z.coerce.number().int().min(0).max(500).default(50),
});

export const SseActivitySchema = ActivityEventSchema;
export const SseIndexerStatusSchema = IndexerStatusSchema;

export const HEARTBEAT_MS = 15_000;

export function eventsRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();
  app.get("/", async (c) => {
    const { since, replay } = parseQuery(c, Query);
    const lastEventId = c.req.header("last-event-id");
    const repos = deps.repos;

    // Resolve the replay set before streaming so a client that disconnects early costs nothing more.
    let history;
    if (lastEventId) history = await repos.activityEvents.listAfter(lastEventId);
    else if (since) history = await repos.activityEvents.listSince(since);
    else history = (await repos.activityEvents.listRecent(replay)).reverse();

    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const send = async (msg: BusMessage): Promise<void> => {
        if (msg.type === "activity") {
          const data = SseActivitySchema.parse(msg.event);
          await stream.writeSSE({ event: "activity", id: data.id, data: JSON.stringify(data) });
        } else {
          await stream.writeSSE({ event: "indexer", data: JSON.stringify(SseIndexerStatusSchema.parse(msg.status)) });
        }
      };

      await send({ type: "indexer", status: deps.indexerStatus() });
      for (const event of history) await send({ type: "activity", event });

      // Live: queue bus messages so writes stay ordered even if one is slow.
      let queue: Promise<void> = Promise.resolve();
      const unsubscribe = deps.bus.subscribe((msg) => {
        queue = queue.then(() => send(msg)).catch(() => undefined);
      });
      const heartbeat = setInterval(() => {
        queue = queue.then(() => stream.writeSSE({ event: "heartbeat", data: new Date().toISOString() })).catch(() => undefined);
      }, HEARTBEAT_MS);

      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        };
        stream.onAbort(done);
        if (c.req.raw.signal.aborted) done();
        else c.req.raw.signal.addEventListener("abort", done, { once: true });
      });
    });
  });
  return app;
}
