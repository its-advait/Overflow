import { ComplaintRecordSchema, ComplaintStatusSchema, type ComplaintRecord, type ComplaintStatus } from "@overflow/schemas";
import { eq } from "drizzle-orm";
import type { Executor } from "../client";
import { NotFoundError, withDbErrors } from "../errors";
import { complaints } from "../schema";
import { iso, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

export type ComplaintInsert = WithOptional<ComplaintRecord, "id" | "createdAt" | "updatedAt" | "status" | "simulated" | "cipherProof">;

const toRecord = (r: typeof complaints.$inferSelect): ComplaintRecord =>
  parseOne(ComplaintRecordSchema, {
    id: r.id,
    purchaseId: r.purchaseId,
    escrowAddress: r.escrowAddress,
    kind: r.kind,
    chunkIndex: r.chunkIndex,
    chunk: r.chunk,
    cipherProof: r.cipherProof,
    plainLeaf: r.plainLeaf,
    plainProof: r.plainProof,
    derivedLeaf: opt(r.derivedLeaf),
    revealedKey: opt(r.revealedKey),
    decryptedRow: opt(r.decryptedRow),
    cipherProofVerified: r.cipherProofVerified,
    plainProofVerified: r.plainProofVerified,
    cheatVerified: r.cheatVerified,
    detail: r.detail,
    status: r.status,
    txHash: opt(r.txHash),
    simulated: r.simulated,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  });

/** One complaint per purchase. `proven` is written only by the indexer's CheatProven handler. */
export function complaintsRepository(db: Executor) {
  const lower = (a: string): string => a.toLowerCase();
  return {
    async insert(input: ComplaintInsert): Promise<ComplaintRecord> {
      const now = nowIso();
      const row = ComplaintRecordSchema.parse({
        status: "built",
        ...input,
        id: input.id ?? newId(),
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      });
      const [inserted] = await withDbErrors(() =>
        db
          .insert(complaints)
          .values({
            id: row.id,
            purchaseId: row.purchaseId,
            escrowAddress: row.escrowAddress,
            kind: row.kind,
            chunkIndex: row.chunkIndex,
            chunk: row.chunk,
            cipherProof: row.cipherProof,
            plainLeaf: row.plainLeaf,
            plainProof: row.plainProof,
            derivedLeaf: nul(row.derivedLeaf),
            revealedKey: nul(row.revealedKey),
            decryptedRow: nul(row.decryptedRow),
            cipherProofVerified: row.cipherProofVerified,
            plainProofVerified: row.plainProofVerified,
            cheatVerified: row.cheatVerified,
            detail: row.detail,
            status: row.status,
            txHash: nul(row.txHash),
            simulated: row.simulated,
            createdAt: new Date(row.createdAt),
            updatedAt: new Date(row.updatedAt),
          })
          .returning(),
      );
      return toRecord(inserted!);
    },

    async getById(id: string): Promise<ComplaintRecord | undefined> {
      const [r] = await db.select().from(complaints).where(eq(complaints.id, id));
      return r ? toRecord(r) : undefined;
    },

    async getByPurchase(purchaseId: string): Promise<ComplaintRecord | undefined> {
      const [r] = await db.select().from(complaints).where(eq(complaints.purchaseId, purchaseId));
      return r ? toRecord(r) : undefined;
    },

    async getByEscrow(escrowAddress: string): Promise<ComplaintRecord | undefined> {
      const rows = await db.select().from(complaints);
      const r = rows.find((row) => lower(row.escrowAddress) === lower(escrowAddress));
      return r ? toRecord(r) : undefined;
    },

    /** The buyer sent it (or it reverted): submitted / rejected with the tx hash when there is one. */
    async setStatus(id: string, to: ComplaintStatus, extra: { txHash?: ComplaintRecord["txHash"] } = {}): Promise<ComplaintRecord> {
      const status = ComplaintStatusSchema.parse(to);
      const [updated] = await withDbErrors(() =>
        db
          .update(complaints)
          .set({ status, updatedAt: new Date(), ...(extra.txHash !== undefined ? { txHash: extra.txHash } : {}) })
          .where(eq(complaints.id, id))
          .returning(),
      );
      if (!updated) throw new NotFoundError("complaints", id);
      return toRecord(updated);
    },

    /** The indexed CheatProven for this escrow: the only path to `proven`. Returns undefined when no complaint was stored. */
    async markProven(escrowAddress: string, txHash: ComplaintRecord["txHash"]): Promise<ComplaintRecord | undefined> {
      const existing = await this.getByEscrow(escrowAddress);
      if (!existing) return undefined;
      return this.setStatus(existing.id, "proven", { txHash });
    },

    async listAll(): Promise<ComplaintRecord[]> {
      const rows = await db.select().from(complaints).orderBy(complaints.createdAt);
      return rows.map(toRecord);
    },
  };
}
