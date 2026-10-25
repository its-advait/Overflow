import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { b32, freshDatabase } from "./test-helpers";

describe("idempotency_keys repository", () => {
  let handle: Awaited<ReturnType<typeof freshDatabase>>;
  beforeAll(async () => {
    handle = await freshDatabase();
  });
  afterAll(() => handle.close());

  it("stores and replays a result", async () => {
    const { idempotencyKeys } = handle.repos;
    expect(await idempotencyKeys.get("k1")).toBeUndefined();
    const { inserted, row: stored } = await idempotencyKeys.put({
      key: "k1",
      scope: "purchases.authorize:p1",
      requestHash: b32(1),
      statusCode: 202,
      response: { ok: true, amountAtomic: "12000000" },
    });
    expect(inserted).toBe(true);
    expect(stored.statusCode).toBe(202);
    expect(await idempotencyKeys.get("k1")).toEqual(stored);
  });

  it("keeps the first result when the same key is written twice", async () => {
    const { idempotencyKeys } = handle.repos;
    const { inserted, row: second } = await idempotencyKeys.put({
      key: "k1",
      scope: "purchases.authorize:p1",
      requestHash: b32(2),
      statusCode: 500,
      response: { ok: false },
    });
    expect(inserted).toBe(false);
    expect(second.requestHash).toBe(b32(1));
    expect(second.statusCode).toBe(202);
  });

  it("rejects a request hash that is not bytes32", async () => {
    const { idempotencyKeys } = handle.repos;
    await expect(
      idempotencyKeys.put({ key: "k2", scope: "s", requestHash: "0x12" as never, statusCode: 200, response: null }),
    ).rejects.toThrow();
  });
});
