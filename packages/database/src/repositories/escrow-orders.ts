import {
  ESCROW_TRANSITIONS,
  EscrowOrderSchema,
  EscrowStatusSchema,
  type EscrowOrder,
  type EscrowStatus,
} from "@overflow/schemas";
import { eq } from "drizzle-orm";
import type { Executor, Tx } from "../client";
import { NotFoundError, withDbErrors } from "../errors";
import { escrowOrders } from "../schema";
import { iso, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

export class InvalidEscrowTransitionError extends Error {
  constructor(
    public readonly from: EscrowStatus,
    public readonly to: EscrowStatus,
  ) {
    super(`invalid escrow transition ${from} -> ${to}`);
    this.name = "InvalidEscrowTransitionError";
  }
}

export type EscrowOrderInsert = WithOptional<EscrowOrder, "id" | "createdAt" | "updatedAt" | "status" | "chunkCount">;

const toRecord = (r: typeof escrowOrders.$inferSelect): EscrowOrder =>
  parseOne(EscrowOrderSchema, {
    id: r.id,
    purchaseId: r.purchaseId,
    orderIdBytes32: r.orderIdBytes32,
    escrowAddress: r.escrowAddress,
    sellerAddress: r.sellerAddress,
    amountAtomic: r.amount,
    bondAtomic: r.bond,
    termsHash: r.termsHash,
    manifestHash: r.manifestHash,
    rootPlain: r.rootPlain,
    rootCipher: r.rootCipher,
    keyCommitment: r.keyCommitment,
    revealDeadline: r.revealDeadline,
    challengeWindow: r.challengeWindow,
    sourceKey: r.sourceKey,
    minTimestamp: r.minTimestamp,
    chunkCount: r.chunkCount,
    status: r.status,
    revealedKey: opt(r.revealedKey),
    challengeEnd: opt(r.challengeEnd),
    refundReason: opt(r.refundReason),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  });

export function escrowOrdersRepository(db: Executor) {
  return {
    async insert(input: EscrowOrderInsert): Promise<EscrowOrder> {
      const now = nowIso();
      const row = EscrowOrderSchema.parse({
        status: "Created",
        ...input,
        id: input.id ?? newId(),
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(escrowOrders)
          .values({
            id: row.id,
            purchaseId: row.purchaseId,
            orderIdBytes32: row.orderIdBytes32,
            escrowAddress: row.escrowAddress,
            sellerAddress: row.sellerAddress,
            amount: row.amountAtomic,
            bond: row.bondAtomic,
            termsHash: row.termsHash,
            manifestHash: row.manifestHash,
            rootPlain: row.rootPlain,
            rootCipher: row.rootCipher,
            keyCommitment: row.keyCommitment,
            revealDeadline: row.revealDeadline,
            challengeWindow: row.challengeWindow,
            sourceKey: row.sourceKey,
            minTimestamp: row.minTimestamp,
            chunkCount: row.chunkCount,
            status: row.status,
            revealedKey: nul(row.revealedKey),
            challengeEnd: nul(row.challengeEnd),
            refundReason: nul(row.refundReason),
            createdAt: new Date(row.createdAt),
            updatedAt: new Date(row.updatedAt),
          })
          .returning(),
      );
      return toRecord(inserted!);
    },

    async getById(id: string): Promise<EscrowOrder | undefined> {
      const [r] = await db.select().from(escrowOrders).where(eq(escrowOrders.id, id));
      return r ? toRecord(r) : undefined;
    },

    async getByPurchase(purchaseId: string): Promise<EscrowOrder | undefined> {
      const [r] = await db.select().from(escrowOrders).where(eq(escrowOrders.purchaseId, purchaseId));
      return r ? toRecord(r) : undefined;
    },

    async getByAddress(escrowAddress: string): Promise<EscrowOrder | undefined> {
      const [r] = await db.select().from(escrowOrders).where(eq(escrowOrders.escrowAddress, escrowAddress));
      return r ? toRecord(r) : undefined;
    },

    /**
     * Mirrors the contract's status after a confirmed event. Follows
     * ESCROW_TRANSITIONS; terminal states never change.
     */
    async setStatus(
      purchaseId: string,
      to: EscrowStatus,
      extra: { revealedKey?: EscrowOrder["revealedKey"]; challengeEnd?: string; refundReason?: string } = {},
    ): Promise<EscrowOrder> {
      const next = EscrowStatusSchema.parse(to);
      return withDbErrors(() =>
        db.transaction(async (tx: Tx) => {
          const [current] = await tx
            .select()
            .from(escrowOrders)
            .where(eq(escrowOrders.purchaseId, purchaseId))
            .for("update");
          if (!current) throw new NotFoundError("escrow_orders", purchaseId);
          if (!ESCROW_TRANSITIONS[current.status].includes(next)) {
            throw new InvalidEscrowTransitionError(current.status, next);
          }
          const [updated] = await tx
            .update(escrowOrders)
            .set({
              status: next,
              updatedAt: new Date(),
              ...(extra.revealedKey !== undefined ? { revealedKey: extra.revealedKey } : {}),
              ...(extra.challengeEnd !== undefined ? { challengeEnd: extra.challengeEnd } : {}),
              ...(extra.refundReason !== undefined ? { refundReason: extra.refundReason } : {}),
            })
            .where(eq(escrowOrders.id, current.id))
            .returning();
          return toRecord(updated!);
        }),
      );
    },

    async listAll(): Promise<EscrowOrder[]> {
      const rows = await db.select().from(escrowOrders).orderBy(escrowOrders.createdAt);
      return rows.map(toRecord);
    },

    async listOpen(): Promise<EscrowOrder[]> {
      const rows = await db.select().from(escrowOrders).orderBy(escrowOrders.createdAt);
      return rows.filter((r) => ESCROW_TRANSITIONS[r.status].length > 0).map(toRecord);
    },
  };
}
