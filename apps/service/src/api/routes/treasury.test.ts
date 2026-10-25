import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE } from "../../chain/fixtures/build-fixture.js";
import { readTreasurySnapshot } from "../../chain/treasury-snapshot.js";
import { replayFixture } from "../../ledger/test-fixture.js";
import { createApp } from "../app.js";

// GET /api/treasury over the SIMULATED fixture: p1 settled, p2 refunded, p3 created and (with its logs dropped, as the
// ledger test does) then marked Funded the way the indexer would on OrderFunded, so one open escrow holds USDC. The
// chain numbers come from the fake reader, pinned to its head block.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("GET /api/treasury (SIMULATED fixture)", () => {
  let r: Awaited<ReturnType<typeof replayFixture>>;

  beforeAll(async () => {
    r = await replayFixture({ exclude: (l) => l.address.toLowerCase() === FIXTURE.escrow3.toLowerCase() });
    await r.handle.repos.escrowOrders.setStatus("p3", "Funded");
  });
  afterAll(() => r.handle.close());

  it("reports balanceOf(treasury) and reservedTotal() at one block beside the USDC the open escrows hold", async () => {
    r.source.setBalance(FIXTURE.usdc, FIXTURE.treasury, 37_400_000n);
    r.source.reserved = 2_500_000n;
    const app = createApp({
      db: r.handle.db,
      ports: { treasury: { read: () => readTreasurySnapshot(r.source, { treasury: FIXTURE.treasury, usdc: FIXTURE.usdc }) } },
      session: { organizationId: "org-demo", principal: "owner", ownerAddress: null },
      treasury: FIXTURE.treasury,
    }).app;
    const res = await app.request("/api/treasury");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.treasury).toBe(FIXTURE.treasury);
    expect(body.chainUnavailable).toBeUndefined();
    expect(body.chain).toMatchObject({
      blockNumber: String(FIXTURE.head),
      balanceAtomic: "37400000",
      reservedTotalAtomic: "2500000",
      usdc: FIXTURE.usdc,
    });
    expect(body.chain.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const statuses = Object.fromEntries((await r.handle.repos.escrowOrders.listAll()).map((o) => [o.purchaseId, o.status]));
    expect(statuses).toEqual({ p1: "Settled", p2: "Refunded", p3: "Funded" });
    expect(body.escrow.openOrders).toBe(1);
    expect(body.escrow.fundedOrders).toBe(1);
    expect(body.escrow.committedAtomic).toBe(FIXTURE.amount);
    expect(body.escrow.orders).toEqual([{ purchaseId: "p3", escrowAddress: FIXTURE.escrow3, status: "Funded", amountAtomic: FIXTURE.amount, funded: true }]);
  });

  it("without a chain reader the chain part is null with the reason; the escrow part still comes from the table", async () => {
    const app = createApp({ db: r.handle.db, session: { organizationId: "org-demo", principal: "owner", ownerAddress: null } }).app;
    const body = await json(await app.request("/api/treasury"));
    expect(body.treasury).toBeNull();
    expect(body.chain).toBeNull();
    expect(body.chainUnavailable).toMatch(/TreasuryPort\.read .* is not wired yet/);
    expect(body.escrow.committedAtomic).toBe(FIXTURE.amount);
  });
});
