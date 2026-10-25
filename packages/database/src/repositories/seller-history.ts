import { AddressSchema, SellerHistorySchema, type SellerHistory } from "@overflow/schemas";
import { eq, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { withDbErrors } from "../errors";
import { sellerHistory } from "../schema";
import { iso, opt, parseOne } from "./base";

export interface SellerHistoryIncrement {
  sellerId?: string;
  orders?: number;
  onTimeReveals?: number;
  lateReveals?: number;
  provenCheats?: number;
  /** Set (not incremented). A proven cheat flags the seller for every later order. */
  flagged?: boolean;
}

const toRecord = (r: typeof sellerHistory.$inferSelect): SellerHistory =>
  parseOne(SellerHistorySchema, {
    sellerAddress: r.sellerAddress,
    sellerId: opt(r.sellerId),
    orders: r.orders,
    onTimeReveals: r.onTimeReveals,
    lateReveals: r.lateReveals,
    provenCheats: r.provenCheats,
    flagged: r.flagged,
    updatedAt: iso(r.updatedAt),
  });

const count = (n: number | undefined): number => {
  if (n === undefined) return 0;
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`increment must be a non-negative integer, got ${n}`);
  return n;
};

/** One row per seller whatever the caller's casing: decoded logs are checksummed, stored purchases often lowercase. */
const canonical = (sellerAddress: string): string => AddressSchema.parse(sellerAddress).toLowerCase();

export function sellerHistoryRepository(db: Executor) {
  return {
    async get(sellerAddress: string): Promise<SellerHistory | undefined> {
      const addr = canonical(sellerAddress);
      const [r] = await db.select().from(sellerHistory).where(eq(sellerHistory.sellerAddress, addr));
      return r ? toRecord(r) : undefined;
    },

    /** Creates the row on first sight, otherwise adds the counters atomically. */
    async upsertIncrement(sellerAddress: string, inc: SellerHistoryIncrement): Promise<SellerHistory> {
      const addr = canonical(sellerAddress);
      const orders = count(inc.orders);
      const onTime = count(inc.onTimeReveals);
      const late = count(inc.lateReveals);
      const cheats = count(inc.provenCheats);
      const flagged = inc.flagged ?? cheats > 0;
      const [r] = await withDbErrors(() =>
        db
          .insert(sellerHistory)
          .values({
            sellerAddress: addr,
            sellerId: inc.sellerId ?? null,
            orders,
            onTimeReveals: onTime,
            lateReveals: late,
            provenCheats: cheats,
            flagged,
          })
          .onConflictDoUpdate({
            target: sellerHistory.sellerAddress,
            set: {
              sellerId: sql`COALESCE(${inc.sellerId ?? null}, ${sellerHistory.sellerId})`,
              orders: sql`${sellerHistory.orders} + ${orders}`,
              onTimeReveals: sql`${sellerHistory.onTimeReveals} + ${onTime}`,
              lateReveals: sql`${sellerHistory.lateReveals} + ${late}`,
              provenCheats: sql`${sellerHistory.provenCheats} + ${cheats}`,
              flagged: inc.flagged === undefined ? sql`${sellerHistory.flagged} OR ${flagged}` : inc.flagged,
              updatedAt: new Date(),
            },
          })
          .returning(),
      );
      return toRecord(r!);
    },

    async listFlagged(): Promise<SellerHistory[]> {
      const rows = await db.select().from(sellerHistory).where(eq(sellerHistory.flagged, true));
      return rows.map(toRecord);
    },
  };
}
