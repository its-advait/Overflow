import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureMissionAndResource, testDatabase } from "../../test-db.js";
import { createApp } from "../app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json() as Promise<any>;
const JSON_HEADERS = { "content-type": "application/json" };

describe("PUT /api/resources/:id (judge control over a SIMULATED listing)", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  let app: ReturnType<typeof createApp>["app"];
  const put = (id: string, body: unknown) => app.request(`/api/resources/${id}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });

  beforeAll(async () => {
    handle = await testDatabase();
    await fixtureMissionAndResource(handle.repos);
    app = createApp({ db: handle.db, session: { organizationId: "org-demo", principal: "owner", ownerAddress: null } }).app;
  });
  afterAll(() => handle.close());

  it("changes price, license flag and seats; the row is what the next Oracle, Fusion and order read", async () => {
    const before = (await handle.repos.resources.getById("resource-1"))!;
    expect(before).toMatchObject({ license: "company-use", simulated: true });

    const r1 = await put("resource-1", { license: "single-user", seats: 1 });
    expect(r1.status).toBe(200);
    expect((await json(r1)).resource).toMatchObject({ id: "resource-1", license: "single-user", seats: 1, priceAtomic: before.priceAtomic });

    const r2 = await put("resource-1", { priceAtomic: "7500000" });
    expect(r2.status).toBe(200);
    expect((await json(r2)).resource).toMatchObject({ priceAtomic: "7500000", license: "single-user", seats: 1 });
    expect(await handle.repos.resources.getById("resource-1")).toMatchObject({ priceAtomic: "7500000", license: "single-user", seats: 1 });

    const list = await json(await app.request("/api/resources"));
    expect(list.resources.find((r: { id: string }) => r.id === "resource-1")).toMatchObject({ priceAtomic: "7500000", license: "single-user" });
  });

  it("refuses an empty edit, a float or negative price, an unknown license, an unknown id and a non-simulated listing", async () => {
    for (const body of [{}, { priceAtomic: "1.5" }, { priceAtomic: "-1" }, { license: "freeware" }, { seats: 0 }]) {
      const res = await put("resource-1", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json(res)).error.code).toBe("validation_error");
    }
    const missing = await put("resource-nope", { license: "unclear" });
    expect(missing.status).toBe(404);
    expect((await json(missing)).error.code).toBe("not_found");

    const real = await handle.repos.resources.insert({
      title: "A real seller's listing",
      sellerId: "real-seller",
      productId: "real-1",
      coverage: { regions: ["US"], dateRange: { start: "2024-01-01", end: "2024-12-31" }, granularity: "monthly", fields: ["a"], format: "csv" },
      license: "company-use",
      priceAtomic: "1000000",
      manifestHash: `0x${"ab".repeat(32)}`,
      seats: 10,
      simulated: false,
    });
    const refused = await put(real.id, { license: "unclear" });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error.code).toBe("not_simulated");
    expect((await handle.repos.resources.getById(real.id))!.license).toBe("company-use");
  });
});
