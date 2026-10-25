import { EventEmitter } from "node:events";
import { ActivityEventSchema, type ActivityEvent } from "@overflow/schemas";
import { z } from "zod";

// ---------------------------------------------------------------------------
// In-process live feed. Everything published here was already committed to
// the database (activity_events) or is the indexer's real status. Nothing on
// the bus is a prediction.
// ---------------------------------------------------------------------------

export const IndexerStatusSchema = z.object({
  state: z.enum(["idle", "starting", "indexing", "stopped"]),
  /** Why the indexer is idle (no RPC, no deployments file, ...). */
  reason: z.string().optional(),
  chainId: z.number().int().optional(),
  treasury: z.string().optional(),
  escrowFactory: z.string().optional(),
  /** Highest block fully scanned (decimal string). */
  cursor: z.string().optional(),
  /** Chain head at the last poll. */
  head: z.string().optional(),
  lagBlocks: z.string().optional(),
  trackedEscrows: z.number().int().min(0).optional(),
  lastPollAt: z.string().optional(),
  lastError: z.string().optional(),
  logsIndexed: z.number().int().min(0).optional(),
});
export type IndexerStatus = z.infer<typeof IndexerStatusSchema>;

export type BusMessage = { type: "activity"; event: ActivityEvent } | { type: "indexer"; status: IndexerStatus };

export interface ActivityBus {
  publish(event: ActivityEvent): void;
  publishStatus(status: IndexerStatus): void;
  subscribe(listener: (msg: BusMessage) => void): () => void;
  listenerCount(): number;
}

export function createActivityBus(): ActivityBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(200);
  return {
    publish(event) {
      emitter.emit("message", { type: "activity", event: ActivityEventSchema.parse(event) } satisfies BusMessage);
    },
    publishStatus(status) {
      emitter.emit("message", { type: "indexer", status: IndexerStatusSchema.parse(status) } satisfies BusMessage);
    },
    subscribe(listener) {
      emitter.on("message", listener);
      return () => emitter.off("message", listener);
    },
    listenerCount: () => emitter.listenerCount("message"),
  };
}
