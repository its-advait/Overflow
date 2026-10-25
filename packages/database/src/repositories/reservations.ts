import { ReservationRecordSchema, type ReservationRecord } from "@overflow/schemas";
import { eq } from "drizzle-orm";
import type { Executor } from "../client";
import { NotFoundError, withDbErrors } from "../errors";
import { reservations } from "../schema";
import { iso, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

export const RESERVATION_DIGEST_CONSTRAINT = "reservations_digest_unique";

export type ReservationInsert = WithOptional<ReservationRecord, "id" | "createdAt" | "updatedAt" | "status">;

const toRecord = (r: typeof reservations.$inferSelect): ReservationRecord =>
  parseOne(ReservationRecordSchema, {
    id: r.id,
    digest: r.digest,
    purchaseId: opt(r.purchaseId),
    nodeId: r.nodeId,
    valueAtomic: r.value,
    validBefore: r.validBefore,
    nonce: r.nonce,
    status: r.status,
    txHash: opt(r.txHash),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  });

export function reservationsRepository(db: Executor) {
  const setStatus = async (
    digest: string,
    status: ReservationRecord["status"],
    txHash?: ReservationRecord["txHash"],
  ): Promise<ReservationRecord> => {
    const [r] = await withDbErrors(() =>
      db
        .update(reservations)
        .set({ status, updatedAt: new Date(), ...(txHash ? { txHash } : {}) })
        .where(eq(reservations.digest, digest))
        .returning(),
    );
    if (!r) throw new NotFoundError("reservations", digest);
    return toRecord(r);
  };

  return {
    /** Mirror of a confirmed `Reserved` event. One row per digest. */
    async insert(input: ReservationInsert): Promise<ReservationRecord> {
      const now = nowIso();
      const row = ReservationRecordSchema.parse({
        status: "active",
        ...input,
        id: input.id ?? newId(),
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(reservations)
          .values({
            id: row.id,
            digest: row.digest,
            purchaseId: nul(row.purchaseId),
            nodeId: row.nodeId,
            value: row.valueAtomic,
            validBefore: row.validBefore,
            nonce: row.nonce,
            status: row.status,
            txHash: nul(row.txHash),
            createdAt: new Date(row.createdAt),
            updatedAt: new Date(row.updatedAt),
          })
          .returning(),
      );
      return toRecord(inserted!);
    },

    async getByDigest(digest: string): Promise<ReservationRecord | undefined> {
      const [r] = await db.select().from(reservations).where(eq(reservations.digest, digest));
      return r ? toRecord(r) : undefined;
    },

    /** USDC moved under the reservation (authorizationState true). */
    markConsumed: (digest: string, txHash?: ReservationRecord["txHash"]) =>
      setStatus(digest, "consumed", txHash),

    /** `release()` confirmed onchain; budget restored only if the nonce was unused. */
    markReleased: (digest: string, txHash?: ReservationRecord["txHash"]) =>
      setStatus(digest, "released", txHash),

    async listActive(): Promise<ReservationRecord[]> {
      const rows = await db
        .select()
        .from(reservations)
        .where(eq(reservations.status, "active"))
        .orderBy(reservations.createdAt);
      return rows.map(toRecord);
    },
  };
}
