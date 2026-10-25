import {
  AllocationRecordSchema,
  PurchaseOrderSchema,
  PurchaseRecordSchema,
  assertTransition,
  type Allocation,
  type AllocationRecord,
  type PurchaseOrder,
  type PurchaseRecord,
  type PurchaseStatus,
} from "@overflow/schemas";
import { and, eq, inArray } from "drizzle-orm";
import type { Executor, Tx } from "../client";
import { NotFoundError, withDbErrors } from "../errors";
import { allocations, purchases } from "../schema";
import { iso, newId, nowIso, nul, opt, parseOne, type WithOptional } from "./base";

/** Name of the partial unique index that enforces one active purchase per (mission, resource). */
export const ACTIVE_PURCHASE_INDEX = "purchases_active_mission_resource_uidx";
export const IDEMPOTENCY_KEY_CONSTRAINT = "purchases_idempotency_key_unique";

export type PurchaseInsert = WithOptional<
  PurchaseRecord,
  "id" | "createdAt" | "updatedAt" | "status" | "txHashes"
>;

type PurchaseRow = typeof purchases.$inferSelect;
type AllocationRow = typeof allocations.$inferSelect;

const toAllocation = (a: AllocationRow): AllocationRecord =>
  parseOne(AllocationRecordSchema, {
    id: a.id,
    purchaseId: a.purchaseId,
    agentId: a.agentId,
    department: a.department,
    amountAtomic: a.amount,
  });

const toRecord = (r: PurchaseRow, allocs: AllocationRow[]): PurchaseRecord =>
  parseOne(PurchaseRecordSchema, {
    id: r.id,
    idempotencyKey: r.idempotencyKey,
    orderIdBytes32: r.orderIdBytes32,
    missionId: r.missionId,
    resourceId: r.resourceId,
    purchaseGroupId: opt(r.purchaseGroupId),
    buyerTreasury: r.buyerTreasury,
    sellerAddress: r.sellerAddress,
    escrowAddress: r.escrowAddress,
    chainId: r.chainId,
    tokenAddress: r.tokenAddress,
    amountAtomic: r.amount,
    payingNodeId: r.payingNodeId,
    participatingAgentIds: r.participatingAgentIds,
    allocations: allocs.map((a): Allocation => ({
      agentId: a.agentId,
      department: a.department,
      amountAtomic: a.amount,
    })),
    resourceManifestHash: r.resourceManifestHash,
    termsHash: r.termsHash,
    paymentPath: r.paymentPath,
    authorizationDigest: opt(r.authorizationDigest),
    txHashes: r.txHashes,
    oracleReason: opt(r.oracleReason),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    authorizationExpiresAt: iso(r.authorizationExpiresAt),
    status: r.status,
  });

const toRow = (row: PurchaseRecord): typeof purchases.$inferInsert => ({
  id: row.id,
  idempotencyKey: row.idempotencyKey,
  orderIdBytes32: row.orderIdBytes32,
  missionId: row.missionId,
  resourceId: row.resourceId,
  purchaseGroupId: nul(row.purchaseGroupId),
  buyerTreasury: row.buyerTreasury,
  sellerAddress: row.sellerAddress,
  escrowAddress: row.escrowAddress,
  chainId: row.chainId,
  tokenAddress: row.tokenAddress,
  amount: row.amountAtomic,
  payingNodeId: row.payingNodeId,
  participatingAgentIds: row.participatingAgentIds,
  resourceManifestHash: row.resourceManifestHash,
  termsHash: row.termsHash,
  paymentPath: row.paymentPath,
  authorizationDigest: nul(row.authorizationDigest),
  txHashes: row.txHashes,
  oracleReason: nul(row.oracleReason),
  status: row.status,
  authorizationExpiresAt: new Date(row.authorizationExpiresAt),
  createdAt: new Date(row.createdAt),
  updatedAt: new Date(row.updatedAt),
});

async function loadAllocations(db: Executor, purchaseIds: string[]): Promise<Map<string, AllocationRow[]>> {
  const map = new Map<string, AllocationRow[]>();
  if (purchaseIds.length === 0) return map;
  const rows = await db.select().from(allocations).where(inArray(allocations.purchaseId, purchaseIds));
  for (const a of rows) {
    const list = map.get(a.purchaseId) ?? [];
    list.push(a);
    map.set(a.purchaseId, list);
  }
  return map;
}

async function hydrate(db: Executor, rows: PurchaseRow[]): Promise<PurchaseRecord[]> {
  const allocs = await loadAllocations(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toRecord(r, allocs.get(r.id) ?? []));
}

async function getByIdOn(db: Executor, id: string): Promise<PurchaseRecord | undefined> {
  const [r] = await db.select().from(purchases).where(eq(purchases.id, id));
  if (!r) return undefined;
  const [rec] = await hydrate(db, [r]);
  return rec;
}

async function getByIdempotencyKeyOn(db: Executor, key: string): Promise<PurchaseRecord | undefined> {
  const [r] = await db.select().from(purchases).where(eq(purchases.idempotencyKey, key));
  if (!r) return undefined;
  const [rec] = await hydrate(db, [r]);
  return rec;
}

export function purchasesRepository(db: Executor) {
  return {
    /**
     * Idempotent create. The same idempotencyKey always resolves to the same
     * purchase (concurrent "buy" calls share one row). A second *active*
     * purchase for the same (mission, resource) with a different key throws
     * UniqueViolationError naming ACTIVE_PURCHASE_INDEX.
     */
    async create(input: PurchaseInsert): Promise<PurchaseRecord> {
      const now = nowIso();
      const row = PurchaseRecordSchema.parse({
        status: "PROPOSED",
        txHashes: [],
        ...input,
        id: input.id ?? newId(),
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      });

      const existing = await getByIdempotencyKeyOn(db, row.idempotencyKey);
      if (existing) return existing;

      return withDbErrors(() =>
        db.transaction(async (tx) => {
          const inserted = await tx
            .insert(purchases)
            .values(toRow(row))
            .onConflictDoNothing({ target: purchases.idempotencyKey })
            .returning();
          if (inserted.length === 0) {
            // Lost the race on idempotency_key: return the winner.
            const winner = await getByIdempotencyKeyOn(tx, row.idempotencyKey);
            if (!winner) throw new NotFoundError("purchases", row.idempotencyKey);
            return winner;
          }
          if (row.allocations.length > 0) {
            await tx.insert(allocations).values(
              row.allocations.map((a) => ({
                id: newId(),
                purchaseId: row.id,
                agentId: a.agentId,
                department: a.department,
                amount: a.amountAtomic,
              })),
            );
          }
          return (await getByIdOn(tx, row.id))!;
        }),
      );
    },

    getById: (id: string) => getByIdOn(db, id),
    getByIdempotencyKey: (key: string) => getByIdempotencyKeyOn(db, key),

    /** The shared PurchaseOrder view (allocations joined), validated by PurchaseOrderSchema. */
    async getOrder(id: string): Promise<PurchaseOrder | undefined> {
      const rec = await getByIdOn(db, id);
      if (!rec) return undefined;
      const { idempotencyKey: _k, purchaseGroupId: _g, oracleReason: _o, updatedAt: _u, ...order } = rec;
      return PurchaseOrderSchema.parse(order);
    },

    /**
     * Moves a purchase along the state machine. Locks the row, checks the
     * transition table from @overflow/schemas, and throws InvalidTransitionError
     * (row untouched) when the move is not allowed.
     */
    async transition(id: string, to: PurchaseStatus): Promise<PurchaseRecord> {
      return withDbErrors(() =>
        db.transaction(async (tx: Tx) => {
          const [current] = await tx.select().from(purchases).where(eq(purchases.id, id)).for("update");
          if (!current) throw new NotFoundError("purchases", id);
          assertTransition(current.status, to);
          await tx
            .update(purchases)
            .set({ status: to, updatedAt: new Date() })
            .where(eq(purchases.id, id));
          return (await getByIdOn(tx, id))!;
        }),
      );
    },

    async setAuthorizationDigest(id: string, digest: PurchaseRecord["authorizationDigest"]): Promise<PurchaseRecord> {
      await withDbErrors(() =>
        db
          .update(purchases)
          .set({ authorizationDigest: nul(digest), updatedAt: new Date() })
          .where(eq(purchases.id, id)),
      );
      const rec = await getByIdOn(db, id);
      if (!rec) throw new NotFoundError("purchases", id);
      return rec;
    },

    /** Appends a tx hash (no duplicates). Settlement state still comes only from chain events. */
    async appendTxHash(id: string, txHash: `0x${string}`): Promise<PurchaseRecord> {
      return withDbErrors(() =>
        db.transaction(async (tx: Tx) => {
          const [current] = await tx.select().from(purchases).where(eq(purchases.id, id)).for("update");
          if (!current) throw new NotFoundError("purchases", id);
          if (!current.txHashes.includes(txHash)) {
            await tx
              .update(purchases)
              .set({ txHashes: [...current.txHashes, txHash], updatedAt: new Date() })
              .where(eq(purchases.id, id));
          }
          return (await getByIdOn(tx, id))!;
        }),
      );
    },

    async listByMission(missionId: string): Promise<PurchaseRecord[]> {
      const rows = await db
        .select()
        .from(purchases)
        .where(eq(purchases.missionId, missionId))
        .orderBy(purchases.createdAt);
      return hydrate(db, rows);
    },

    async listByStatus(status: PurchaseStatus): Promise<PurchaseRecord[]> {
      const rows = await db.select().from(purchases).where(eq(purchases.status, status)).orderBy(purchases.createdAt);
      return hydrate(db, rows);
    },

    /** Existing-asset check for Oracle: settled purchases of a resource. */
    async findSettledForResource(missionId: string, resourceId: string): Promise<PurchaseRecord[]> {
      const rows = await db
        .select()
        .from(purchases)
        .where(
          and(
            eq(purchases.missionId, missionId),
            eq(purchases.resourceId, resourceId),
            eq(purchases.status, "SETTLED"),
          ),
        );
      return hydrate(db, rows);
    },
  };
}

export function allocationsRepository(db: Executor) {
  return {
    async listByPurchase(purchaseId: string): Promise<AllocationRecord[]> {
      const rows = await db.select().from(allocations).where(eq(allocations.purchaseId, purchaseId));
      return rows.map(toAllocation);
    },

    /** Replaces the subledger split for a purchase. Totals are checked by PurchaseOrderSchema on read. */
    async replaceForPurchase(purchaseId: string, next: Allocation[]): Promise<AllocationRecord[]> {
      return withDbErrors(() =>
        db.transaction(async (tx: Tx) => {
          await tx.delete(allocations).where(eq(allocations.purchaseId, purchaseId));
          if (next.length > 0) {
            await tx.insert(allocations).values(
              next.map((a) => ({
                id: newId(),
                purchaseId,
                agentId: a.agentId,
                department: a.department,
                amount: a.amountAtomic,
              })),
            );
          }
          const rows = await tx.select().from(allocations).where(eq(allocations.purchaseId, purchaseId));
          return rows.map(toAllocation);
        }),
      );
    },
  };
}
