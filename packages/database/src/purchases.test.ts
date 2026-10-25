import { InvalidTransitionError, PurchaseOrderSchema } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UniqueViolationError } from "./errors";
import { ACTIVE_PURCHASE_INDEX } from "./repositories";
import { b32, freshDatabase, purchaseInput, seedFixture } from "./test-helpers";

describe("purchases repository", () => {
  let handle: Awaited<ReturnType<typeof freshDatabase>>;
  beforeAll(async () => {
    handle = await freshDatabase();
    await seedFixture(handle.repos);
  });
  afterAll(() => handle.close());

  it("resolves the same idempotency key to one purchase", async () => {
    const { purchases } = handle.repos;
    const first = await purchases.create(purchaseInput());
    const second = await purchases.create(purchaseInput({ orderIdBytes32: b32(2) }));
    expect(second.id).toBe(first.id);
    expect(second.orderIdBytes32).toBe(first.orderIdBytes32);
    expect((await purchases.listByMission("mission-1")).length).toBe(1);
    expect(first.status).toBe("PROPOSED");
    expect(first.allocations).toHaveLength(2);
  });

  it("rejects a second active purchase for the same (mission, resource) with a unique violation", async () => {
    const { purchases } = handle.repos;
    await expect(
      purchases.create(purchaseInput({ idempotencyKey: "mission-1:resource-1:2", orderIdBytes32: b32(3) })),
    ).rejects.toBeInstanceOf(UniqueViolationError);
    try {
      await purchases.create(purchaseInput({ idempotencyKey: "mission-1:resource-1:3", orderIdBytes32: b32(4) }));
    } catch (e) {
      expect((e as UniqueViolationError).constraint).toBe(ACTIVE_PURCHASE_INDEX);
    }
    expect((await purchases.listByMission("mission-1")).length).toBe(1);
  });

  it("allows a new active purchase once the earlier one is terminal (index is partial)", async () => {
    const { purchases } = handle.repos;
    const [first] = await purchases.listByMission("mission-1");
    await purchases.transition(first!.id, "REJECTED");
    const replacement = await purchases.create(
      purchaseInput({ idempotencyKey: "mission-1:resource-1:4", orderIdBytes32: b32(5) }),
    );
    expect(replacement.id).not.toBe(first!.id);
    expect((await purchases.listByMission("mission-1")).length).toBe(2);
  });

  it("refuses an invalid transition and leaves the row unchanged", async () => {
    const { purchases } = handle.repos;
    const rejected = (await purchases.listByStatus("REJECTED"))[0]!;
    await expect(purchases.transition(rejected.id, "PROPOSED")).rejects.toBeInstanceOf(InvalidTransitionError);
    expect((await purchases.getById(rejected.id))!.status).toBe("REJECTED");
    expect((await purchases.getById(rejected.id))!.updatedAt).toBe(rejected.updatedAt);
  });

  it("walks the happy path and keeps authorization, funding and settlement as separate steps", async () => {
    const { purchases } = handle.repos;
    const active = (await purchases.listByStatus("PROPOSED"))[0]!;
    const steps = ["RESERVED", "PAYMENT_PENDING", "ESCROW_FUNDED", "DELIVERY_PENDING", "SETTLED"] as const;
    let current = active;
    for (const to of steps) {
      current = await purchases.transition(current.id, to);
      expect(current.status).toBe(to);
    }
    const withTx = await purchases.appendTxHash(current.id, b32(77));
    expect(withTx.txHashes).toEqual([b32(77)]);
    expect((await purchases.appendTxHash(current.id, b32(77))).txHashes).toEqual([b32(77)]);
  });

  it("getOrder returns a PurchaseOrderSchema-valid object whose allocations sum to the amount", async () => {
    const { purchases } = handle.repos;
    const settled = (await purchases.listByStatus("SETTLED"))[0]!;
    const order = await purchases.getOrder(settled.id);
    expect(PurchaseOrderSchema.safeParse(order).success).toBe(true);
    expect(order).not.toHaveProperty("idempotencyKey");
    const sum = order!.allocations.reduce((acc, a) => acc + BigInt(a.amountAtomic), 0n);
    expect(sum).toBe(BigInt(order!.amountAtomic));
    expect((await purchases.findSettledForResource("mission-1", "resource-1")).length).toBe(1);
  });

  it("rejects float or numeric amounts before touching the database", async () => {
    const { purchases } = handle.repos;
    await expect(
      purchases.create(purchaseInput({ idempotencyKey: "bad-1", amountAtomic: "12.5" })),
    ).rejects.toThrow();
    await expect(
      purchases.create(
        purchaseInput({ idempotencyKey: "bad-2", amountAtomic: 12000000 as unknown as string }),
      ),
    ).rejects.toThrow();
    expect(await purchases.getByIdempotencyKey("bad-1")).toBeUndefined();
  });
});
