import type { Address, EscrowStatus, Hex } from "@overflow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { b32, ESCROW, fixtureMissionAndResource, purchaseInput, SELLER, testDatabase, TREASURY } from "../../test-db.js";
import { createApp } from "../app.js";
import type { EscrowReadPort } from "../ports.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** SIMULATED chain: one escrow's state answered from memory at a fixed block; never an RPC. */
function fakeRead(state: { status: EscrowStatus; challengeEnd: bigint; revealedKey: Hex; balance: bigint; now: bigint }): EscrowReadPort {
  return {
    latest: async () => ({ blockNumber: 49_900_000n, blockTimestamp: state.now }),
    state: async (escrow: Address) => {
      if (escrow.toLowerCase() !== ESCROW.toLowerCase()) throw new Error(`unknown escrow ${escrow}`);
      return { status: state.status, challengeEnd: state.challengeEnd, revealedKey: state.revealedKey, balance: state.balance };
    },
  };
}

describe("GET /api/escrow", () => {
  let handle: Awaited<ReturnType<typeof testDatabase>>;
  const session = { organizationId: "org-demo", principal: "owner", ownerAddress: null };
  const REVEAL_DEADLINE = 1_800_000_000n;
  const appWith = (port?: EscrowReadPort) =>
    createApp({ db: handle.db, ports: port ? { escrowRead: port } : {}, session, treasury: TREASURY }).app;

  beforeAll(async () => {
    handle = await testDatabase();
    await fixtureMissionAndResource(handle.repos);
    await handle.repos.purchases.create(purchaseInput({ id: "p1" }));
    await handle.repos.escrowOrders.insert({
      purchaseId: "p1",
      orderIdBytes32: b32(1),
      escrowAddress: ESCROW,
      sellerAddress: SELLER,
      amountAtomic: "12000000",
      bondAtomic: "2400000",
      termsHash: b32(9),
      manifestHash: b32(5),
      rootPlain: b32(21),
      rootCipher: b32(22),
      keyCommitment: b32(23),
      revealDeadline: REVEAL_DEADLINE.toString(),
      challengeWindow: "600",
      sourceKey: TREASURY,
      minTimestamp: "0",
      chunkCount: 7,
    });
    await handle.repos.samples.insert({
      purchaseId: "p1",
      indices: [3, 0, 4],
      randomness: b32(0x5a),
      verdict: "buy",
      reason: "3 sampled chunks verified",
      judge: "rule:recourse-sample-v1 (SIMULATED, no model)",
      rows: [{ index: 3, cipherChunk: "0xab", chunkKey: b32(1), plainLeaf: b32(2), cipherProof: [b32(3)], plainProof: [b32(4)], verified: "ok", row: "2024-01,CA,Voltara,8249,simulated", timestamp: "1704067200" }],
      simulated: true,
    });
    await handle.repos.complaints.insert({
      purchaseId: "p1",
      escrowAddress: ESCROW,
      kind: "mismatch",
      chunkIndex: 3,
      chunk: "0xab",
      cipherProof: [b32(3)],
      plainLeaf: b32(2),
      plainProof: [b32(4)],
      derivedLeaf: b32(7),
      revealedKey: b32(0x77),
      cipherProofVerified: true,
      plainProofVerified: true,
      cheatVerified: true,
      detail: "chunk 3 decrypts to another leaf",
      simulated: true,
    });
  });
  afterAll(async () => handle.close());

  it("lists every order with its purchase, resource label, complaint status and the simulated flag", async () => {
    const res = await appWith().request("/api/escrow");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.escrows).toHaveLength(1);
    expect(body.escrows[0]).toMatchObject({
      purchaseId: "p1",
      escrowAddress: ESCROW,
      status: "Created",
      purchaseStatus: "PROPOSED",
      amountAtomic: "12000000",
      bondAtomic: "2400000",
      resource: { id: "resource-1", sellerId: "seller-honest", simulated: true },
      complaint: "built",
      simulated: true,
    });
  });

  it("detail without a chain reader still renders the stored evidence and says why chain and actions are null", async () => {
    const res = await appWith().request("/api/escrow/p1");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.escrow).toMatchObject({ escrowAddress: ESCROW, chunkCount: 7, status: "Created" });
    expect(body.purchase.id).toBe("p1");
    expect(body.chain).toBeNull();
    expect(body.actions).toBeNull();
    expect(body.chainUnavailable).toMatch(/EscrowReadPort.*not wired/);
    expect(body.sample).toMatchObject({ verdict: "buy", indices: [3, 0, 4], judge: expect.stringMatching(/SIMULATED/) });
    expect(body.sample.rows[0]).toMatchObject({ index: 3, verified: "ok", row: expect.stringContaining("Voltara") });
    expect(body.complaint).toMatchObject({ kind: "mismatch", chunkIndex: 3, status: "built", cipherProofVerified: true, plainProofVerified: true, cheatVerified: true });
    expect(body.simulated).toBe(true);
    expect(Array.isArray(body.activity)).toBe(true);
    expect((await appWith().request("/api/escrow/p1/actions")).status).toBe(501);
  });

  it("the escrow address works as :id, case-insensitively", async () => {
    expect((await appWith().request(`/api/escrow/${ESCROW}`)).status).toBe(200);
    expect((await appWith().request(`/api/escrow/${ESCROW.toUpperCase().replace("0X", "0x")}`)).status).toBe(200);
    expect((await appWith().request("/api/escrow/nope")).status).toBe(404);
  });

  it("Revealed inside the challenge window: accept and complain allowed (proofs verified), finalize waits, chain state is the port's", async () => {
    const port = fakeRead({ status: "Revealed", challengeEnd: 1_700_000_600n, revealedKey: b32(0x77), balance: 14_400_000n, now: 1_700_000_100n });
    const body = await json(await appWith(port).request("/api/escrow/p1"));
    expect(body.chain).toEqual({ status: "Revealed", challengeEnd: "1700000600", revealedKey: b32(0x77), balanceAtomic: "14400000", blockNumber: "49900000", blockTimestamp: "1700000100" });
    expect(body.actions.asOf).toBe("1700000100");
    expect(body.actions.accept.allowed).toBe(true);
    expect(body.actions.complain).toMatchObject({ allowed: true, until: "1700000600" });
    expect(body.actions.finalizePayout).toMatchObject({ allowed: false, reason: expect.stringMatching(/^ChallengeOpen/), availableAt: "1700000600" });
    expect(body.actions.claimTimeoutRefund).toMatchObject({ allowed: false, reason: "BadStatus(Revealed)" });
    expect(body.actions.sweep.allowed).toBe(false);
    // The stored status stays what the indexer confirmed; the page shows the disagreement, the API does not paper over it.
    expect(body.escrow.status).toBe("Created");
  });

  it("GET /:id/actions: Created past the reveal deadline allows only claimTimeoutRefund", async () => {
    const port = fakeRead({ status: "Created", challengeEnd: 0n, revealedKey: b32(0), balance: 0n, now: REVEAL_DEADLINE + 1n });
    const res = await appWith(port).request("/api/escrow/p1/actions");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.escrowAddress).toBe(ESCROW);
    expect(Object.fromEntries(Object.entries(body.actions).filter(([k]) => k !== "asOf").map(([k, g]) => [k, (g as { allowed: boolean }).allowed]))).toEqual({
      accept: false,
      finalizePayout: false,
      claimTimeoutRefund: true,
      complain: false,
      sweep: false,
    });
  });

  it("a failing reader answers 503 on /actions and degrades the detail instead of inventing state", async () => {
    const broken: EscrowReadPort = { latest: async () => { throw new Error("rpc down"); }, state: async () => { throw new Error("rpc down"); } };
    expect((await appWith(broken).request("/api/escrow/p1/actions")).status).toBe(503);
    const body = await json(await appWith(broken).request("/api/escrow/p1"));
    expect(body.chain).toBeNull();
    expect(body.chainUnavailable).toMatch(/rpc down/);
  });
});
