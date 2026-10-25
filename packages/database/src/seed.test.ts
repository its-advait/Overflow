import { OrganizationSchema } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COMPANY_NAME, SEED_ORGANIZATION_ID, seed } from "./seed";
import { freshDatabase } from "./test-helpers";

describe("seed", () => {
  let handle: Awaited<ReturnType<typeof freshDatabase>>;
  beforeAll(async () => {
    handle = await freshDatabase();
  });
  afterAll(() => handle.close());

  it("creates one simulated organization with two departments and three agents", async () => {
    const result = await seed(handle.db, { companyName: undefined });
    expect(OrganizationSchema.safeParse(result.organization).success).toBe(true);
    expect(result.organization.id).toBe(SEED_ORGANIZATION_ID);
    expect(result.organization.simulated).toBe(true);
    expect(result.organization.departments).toEqual(["research", "finance"]);
    expect(result.agents.map((a) => a.department).sort()).toEqual(["finance", "research", "research"]);
    expect(typeof result.organization.name).toBe("string");
    if (!process.env["COMPANY_NAME"]) expect(result.organization.name).toBe(DEFAULT_COMPANY_NAME);
  });

  it("is idempotent", async () => {
    await seed(handle.db);
    expect((await handle.repos.organizations.list()).length).toBe(1);
    expect((await handle.repos.agents.listByOrganization(SEED_ORGANIZATION_ID)).length).toBe(3);
  });

  it("honours an explicit company name on a fresh database", async () => {
    const other = await freshDatabase();
    try {
      const result = await seed(other.db, { companyName: "FICTIONAL Harbor Analytics" });
      expect(result.organization.name).toBe("FICTIONAL Harbor Analytics");
    } finally {
      await other.close();
    }
  });
});
