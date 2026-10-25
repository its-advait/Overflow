import { ControllerRequestSchema, type ControllerRequest, type ControllerRequestStatus } from "@overflow/schemas";
import { eq } from "drizzle-orm";
import type { Executor } from "../client";
import { NotFoundError, withDbErrors } from "../errors";
import { controllerRequests } from "../schema";
import { iso, isoOpt, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

export type ControllerRequestInsert = WithOptional<ControllerRequest, "id" | "createdAt" | "status">;

const toRecord = (r: typeof controllerRequests.$inferSelect): ControllerRequest =>
  parseOne(ControllerRequestSchema, {
    id: r.id,
    action: r.action,
    exceptionId: opt(r.exceptionId),
    requestedBy: r.requestedBy,
    reason: r.reason,
    target: r.target,
    data: r.data,
    value: r.value,
    summary: r.summary,
    status: r.status,
    createdAt: iso(r.createdAt),
    resolvedAt: isoOpt(r.resolvedAt),
    txHash: opt(r.txHash),
  });

export function controllerRequestsRepository(db: Executor) {
  return {
    /** Records what an agent asked the controller to do, with the prepared calldata. Nothing here executes the action. */
    async insert(input: ControllerRequestInsert): Promise<ControllerRequest> {
      const row = ControllerRequestSchema.parse({
        status: "pending",
        ...input,
        id: input.id ?? newId(),
        createdAt: input.createdAt ?? nowIso(),
      });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(controllerRequests)
          .values({
            id: row.id,
            action: row.action,
            exceptionId: nul(row.exceptionId),
            requestedBy: row.requestedBy,
            reason: row.reason,
            target: row.target,
            data: row.data,
            value: row.value,
            summary: row.summary,
            status: row.status,
            txHash: nul(row.txHash),
            createdAt: new Date(row.createdAt),
            resolvedAt: row.resolvedAt ? new Date(row.resolvedAt) : null,
          })
          .returning(),
      );
      return toRecord(inserted!);
    },

    async getById(id: string): Promise<ControllerRequest | undefined> {
      const [r] = await db.select().from(controllerRequests).where(eq(controllerRequests.id, id));
      return r ? toRecord(r) : undefined;
    },

    /**
     * "rejected" comes from the human; "done" only once the owner transaction
     * is confirmed and indexed, so its txHash is required.
     */
    async resolve(id: string, status: "done" | "rejected", txHash?: ControllerRequest["txHash"]): Promise<ControllerRequest> {
      if (status === "done" && !txHash) {
        throw new Error("a done controller request needs the confirmed txHash");
      }
      const [r] = await withDbErrors(() =>
        db
          .update(controllerRequests)
          .set({ status, resolvedAt: new Date(), ...(txHash ? { txHash } : {}) })
          .where(eq(controllerRequests.id, id))
          .returning(),
      );
      if (!r) throw new NotFoundError("controller_requests", id);
      return toRecord(r);
    },

    async listPending(): Promise<ControllerRequest[]> {
      return this.list("pending");
    },

    /** Oldest first. */
    async list(status: ControllerRequestStatus | "all" = "all"): Promise<ControllerRequest[]> {
      const q = db.select().from(controllerRequests);
      const rows = await (status === "all" ? q : q.where(eq(controllerRequests.status, status))).orderBy(controllerRequests.createdAt);
      return rows.map(toRecord);
    },

    async listByExceptionId(exceptionId: string): Promise<ControllerRequest[]> {
      const rows = await db
        .select()
        .from(controllerRequests)
        .where(eq(controllerRequests.exceptionId, exceptionId))
        .orderBy(controllerRequests.createdAt);
      return rows.map(toRecord);
    },
  };
}
