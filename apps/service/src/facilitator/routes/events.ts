import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { FacilitatorDeps } from "../context";
import type { FeedEvent } from "../events";

/** SSE: replay the ring buffer, then live events; heartbeat comment every 15 s. */
export function eventRoutes(deps: FacilitatorDeps, heartbeatMs = 15_000) {
  const app = new Hono();
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let lastSeq = 0;
      const send = async (e: FeedEvent) => {
        if (e.seq <= lastSeq) return; // already sent during replay
        lastSeq = e.seq;
        await stream.writeSSE({ id: String(e.seq), event: e.kind, data: JSON.stringify(e) });
      };
      // Subscribe before replaying so nothing published while the replay is being read is lost.
      const queue: FeedEvent[] = [];
      let wake: (() => void) | undefined;
      const unsub = deps.bus.subscribe((e) => {
        queue.push(e);
        wake?.();
      });
      let open = true;
      stream.onAbort(() => {
        open = false;
        unsub();
        wake?.();
      });
      for (const e of deps.bus.replay()) await send(e);
      while (open) {
        while (queue.length) await send(queue.shift()!);
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, heartbeatMs);
        });
        wake = undefined;
        if (open && !queue.length) await stream.write(": hb\n\n");
      }
    }),
  );
  return app;
}
