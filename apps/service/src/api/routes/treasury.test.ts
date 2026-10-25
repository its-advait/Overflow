import type { Address } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE } from "../../chain/fixtures/build-fixture.js";
import { readTreasurySnapshot } from "../../chain/treasury-snapshot.js";
import { replayFixture } from "../../ledger/test-fixture.js";
import type { TreasuryNode } from "../../orchestration/delegation-plan.js";
import { b32, testDatabase, TREASURY } from "../../test-db.js";
import { createApp } from "../app.js";
import type { TreasuryReadPort } from "../ports.js";
import { deriveStatus, replayAllowlist, type ReadNode } from "./treasury.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const KEY = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const PAYEE_A = KEY(0xa);
const PAYEE_B = KEY(0xb);
const FAR = 4_000_000_000n;
const PAST = 1_000n;

const node = (over: Partial<TreasuryNode> & { parent: bigint; depth: bigint }): TreasuryNode => ({
  key: KEY(1),
  cap: 100_000_000n,
  spent: 0n,
  maxPerCall: 10_000_000n,
  expiry: FAR,
  paused: false,
  restricted: false,
  ...over,
});

/**
 * SIMULATED treasury: a fixed tree answered from memory, never a chain. The ids follow the
 * contract (1-based, parent 0 = none); remaining() is min(cap - spent) over the ancestor walk.
 */
function fakeRead(nodes: Map<number, TreasuryNode>, nodeAllow: (id: number, payee: Address) => boolean): TreasuryReadPort {
  const remaining = (id: number): bigint => {
    let best: bigint | null = null;
    for (let cur = id; cur !== 0; ) {
      const n = nodes.get(cur)!;
      const r = n.cap - n.spent;
      best = best === null || r < best ? r : best;
      cur = Number(n.parent);
    }
    return best ?? 0n;
  };
  return {
    blockNumber: async () => 49_900_000n,
    nodeCount: async () => BigInt(nodes.size),
    getNode: async (id) => nodes.get(Number(id))!,
    remaining: async (id) => remaining(Number(id)),
    allowlist: async (payee) => payee === PAYEE_A,
    nodeAllow: async (id, payee) => nodeAllow(Number(id), payee),
  };
}

describe("GET /api/treasury/nodes", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  let app: ReturnType<typeof createApp>["app"];
  const session = { organizationId: "org-demo", principal: "owner", ownerAddress: null };

  // root 1 (orchestrator key) -> child 2 (paused, spent 5) -> grandchild 3 (restricted); child 4 expired; 5 unlabeled
  const tree = new Map<number, TreasuryNode>([
    [1, node({ parent: 0n, depth: 0n, key: KEY(0x0a01), spent: 5_000_000n })],
    [2, node({ parent: 1n, depth: 1n, key: KEY(0x0a02), cap: 25_000_000n, spent: 5_000_000n, paused: true })],
    [3, node({ parent: 2n, depth: 2n, key: KEY(0x0a03), cap: 10_000_000n, spent: 2_000_000n, restricted: true })],
    [4, node({ parent: 1n, depth: 1n, key: KEY(0x0a04), cap: 20_000_000n, expiry: PAST })],
    [5, node({ parent: 1n, depth: 1n, key: KEY(0x0a05), cap: 1_000_000n })],
  ]);

  beforeAll(async () => {
    handle = await testDatabase();
    // The seed's agents carry placeholder keys ending in 0A01..0A03; node 1 and 2 are linked by key, node 3 by nodeId.
    const research = await handle.repos.agents.getById("agent-research");
    await handle.repos.agents.setNodeId("agent-research", 3);
    expect(research).toBeDefined();
    // AllowSet replay: A allowed, B allowed then revoked.
    let seq = 0;
    const rec = (logIndex: number, block: string, payee: Address, allowed: boolean) =>
      handle.repos.chainTransactions.record({
        txHash: b32(0x100 + seq++),
        logIndex,
        blockNumber: block,
        contractAddress: TREASURY,
        eventName: "AllowSet",
        args: { payee, allowed: String(allowed) },
      });
    await rec(0, "100", PAYEE_A, true);
    await rec(1, "100", PAYEE_B, true);
    await rec(0, "101", PAYEE_B, false);
    // Two Paid logs for node 3 and one for node 1.
    const paid = (logIndex: number, block: string, id: number, value: string) =>
      handle.repos.chainTransactions.record({
        txHash: b32(0x200 + seq++),
        logIndex,
        blockNumber: block,
        contractAddress: TREASURY,
        eventName: "Paid",
        args: { id: String(id), to: PAYEE_A, value, nonce: b32(0x300 + logIndex) },
      });
    await paid(0, "102", 3, "1500000");
    await paid(1, "103", 1, "5000000");
    await paid(2, "104", 3, "500000");
    app = createApp({
      db: handle.db,
      session,
      treasury: TREASURY,
      ports: { treasuryRead: fakeRead(tree, (id, payee) => id === 3 && payee === PAYEE_A) },
    }).app;
  });
  afterAll(() => handle.close());

  it("reads every node, joins agents by nodeId or key, derives remaining and the pause / expiry cascade", async () => {
    const res = await app.request("/api/treasury/nodes");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.treasury).toBe(TREASURY);
    expect(body.blockNumber).toBe("49900000");
    expect(body.simulated).toBe(false);
    expect(body.allowlist).toEqual([PAYEE_A]);
    expect(body.nodes).toHaveLength(5);
    const by = Object.fromEntries(body.nodes.map((n: { id: number }) => [n.id, n]));

    expect(by[1].status).toBe("running");
    expect(by[1].remaining).toBe("95000000");
    expect(by[1].agent).toMatchObject({ id: "agent-orchestrator" }); // by key match (seed has no nodeId)
    expect(by[1].payees).toEqual({ mode: "global", known: [PAYEE_A], complete: true });

    expect(by[2]).toMatchObject({ status: "paused", pausedBy: 2, expiredBy: null, remaining: "20000000" });
    // Grandchild under the paused child: paused by its ancestor, remaining bound by the ancestor (8 vs 20 vs 95).
    expect(by[3]).toMatchObject({ status: "paused", pausedBy: 2, remaining: "8000000", agentId: "agent-research" });
    expect(by[3].agent).toMatchObject({ id: "agent-research", role: expect.any(String) });
    expect(by[3].payees).toEqual({ mode: "restricted", known: [PAYEE_A], complete: false });

    expect(by[4]).toMatchObject({ status: "expired", expiredBy: 4, pausedBy: null });
    expect(by[5]).toMatchObject({ status: "running", agent: null, remaining: "1000000" });
    expect(by[5].agentId).toBeUndefined();
  });

  it("lists one node's Paid logs, newest block first, and ignores other nodes", async () => {
    const res = await app.request("/api/treasury/nodes/3/payments");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.nodeId).toBe(3);
    expect(body.simulated).toBe(false);
    expect(body.payments.map((p: { value: string }) => p.value)).toEqual(["500000", "1500000"]);
    expect(body.payments[0]).toMatchObject({ to: PAYEE_A, blockNumber: "104", nodeId: 3, simulated: false });
    const none = await json(await app.request("/api/treasury/nodes/9/payments"));
    expect(none.payments).toEqual([]);
    expect((await app.request("/api/treasury/nodes/abc/payments")).status).toBe(400);
  });

  it("answers 501 not_wired without a treasury read port and without a treasury", async () => {
    const noPort = createApp({ db: handle.db, session, treasury: TREASURY }).app;
    const res = await noPort.request("/api/treasury/nodes");
    expect(res.status).toBe(501);
    expect((await json(res)).error.code).toBe("not_wired");
    const noTreasury = createApp({ db: handle.db, session, ports: { treasuryRead: fakeRead(tree, () => false) } }).app;
    expect((await noTreasury.request("/api/treasury/nodes")).status).toBe(501);
  });

  it("filters activity by agentId, newest first", async () => {
    await handle.repos.activityEvents.insert({ kind: "policy.blocked", message: "refused", agentId: "agent-research", decodedRevert: "OverBudget(2)", at: "2026-10-25T10:00:00.000Z" });
    await handle.repos.activityEvents.insert({ kind: "agent.tool_call", message: "later", agentId: "agent-research", at: "2026-10-25T10:01:00.000Z" });
    await handle.repos.activityEvents.insert({ kind: "agent.tool_call", message: "other agent", agentId: "agent-finance", at: "2026-10-25T10:02:00.000Z" });
    const res = await app.request("/api/activity?agentId=agent-research");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.events.map((e: { message: string }) => e.message)).toEqual(["later", "refused"]);
    expect(body.events[1].decodedRevert).toBe("OverBudget(2)");
  });
});

describe("deriveStatus / replayAllowlist (pure)", () => {
  const rn = (id: number, parent: number, over: Partial<ReadNode> = {}): [number, ReadNode] => [
    id,
    { id, key: KEY(id), parent: BigInt(parent), depth: 0n, cap: 10n, spent: 0n, maxPerCall: 10n, expiry: FAR, paused: false, restricted: false, remaining: 10n, ...over },
  ];
  it("paused wins over expired and names the nearest cause", () => {
    const nodes = new Map([rn(1, 0, { expiry: PAST }), rn(2, 1, { paused: true }), rn(3, 2)]);
    expect(deriveStatus(nodes, 3, 2_000n)).toEqual({ status: "paused", pausedBy: 2, expiredBy: 1 });
    expect(deriveStatus(nodes, 1, 2_000n)).toEqual({ status: "expired", pausedBy: null, expiredBy: 1 });
  });
  it("a running leaf under a running root is running; a missing parent stops the walk", () => {
    const nodes = new Map([rn(1, 0), rn(2, 1), rn(7, 9)]);
    expect(deriveStatus(nodes, 2, 2_000n)).toEqual({ status: "running", pausedBy: null, expiredBy: null });
    expect(deriveStatus(nodes, 7, 2_000n).status).toBe("running");
  });
  it("replays AllowSet with last-write-wins, case-insensitively", () => {
    const row = (payee: string, allowed: string | boolean) =>
      ({ args: { payee, allowed } }) as unknown as Parameters<typeof replayAllowlist>[0][number];
    const upper = PAYEE_B.toUpperCase().replace("0X", "0x");
    expect(replayAllowlist([row(PAYEE_A, "true"), row(PAYEE_B, true), row(upper, "false")])).toEqual([PAYEE_A]);
  });
});

// GET /api/treasury over the SIMULATED fixture: p1 settled, p2 refunded, p3 created and (with its logs dropped, as the
// ledger test does) then marked Funded the way the indexer would on OrderFunded, so one open escrow holds USDC. The
// chain numbers come from the fake reader, pinned to its head block.
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
    expect(statuses).toEqual({ p1: "Settled", p2: "Refunded", p3: "Funded", p5: "Refunded" }); // p5: the fixture's proven-mismatch order, closed
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
