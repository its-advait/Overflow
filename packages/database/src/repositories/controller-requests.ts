import { ControllerRequestSchema, type ControllerRequest } from "@overflow/schemas";
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
    requestedBy: r.requestedBy,
    reason: r.reason,
    status: r.status,
    createdAt: iso(r.createdAt),
    resolvedAt: isoOpt(r.resolvedAt),
    txHash: opt(r.txHash),
  });

export function controllerRequestsRepository(db: Executor) {
  return {
    /** Records what an agent asked the controller to do. Nothing here executes the action. */
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
            requestedBy: row.requestedBy,
            reason: row.reason,
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
     * "approved"/"rejected" come from the human; "executed" only once the owner
     * transaction is confirmed, so txHash is required for it.
     */
    async resolve(
      id: string,
      status: "approved" | "rejected" | "executed",
      txHash?: ControllerRequest["txHash"],
    ): Promise<ControllerRequest> {
      if (status === "executed" && !txHash) {
        throw new Error("an executed controller request needs the confirmed txHash");
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
      const rows = await db
        .select()
        .from(controllerRequests)
        .where(eq(controllerRequests.status, "pending"))
        .orderBy(controllerRequests.createdAt);
      return rows.map(toRecord);
    },
  };
}
