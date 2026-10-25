import { readFileSync } from "node:fs";
import type { RawLog } from "../chain/log-source.js";
import { fakeLogSource } from "../chain/fake-source.js";
import { FIXTURE } from "../chain/fixtures/build-fixture.js";
import { createIndexer } from "../chain/indexer.js";
import { createPurchaseService } from "../orchestration/purchase-service.js";
import { b32, fixtureMissionAndResource, purchaseInput, testDatabase } from "../test-db.js";

const fixture = JSON.parse(readFileSync(new URL("../chain/fixtures/base-sepolia-logs.json", import.meta.url), "utf8")) as { logs: RawLog[] };

const config = {
  chainId: 84532 as const,
  rpcUrl: "http://fake.invalid",
  treasury: FIXTURE.treasury,
  escrowFactory: FIXTURE.factory,
  usdc: FIXTURE.usdc,
  deployBlock: FIXTURE.deployBlock,
  pollMs: 2000,
  reorgDepth: 12,
  chunkBlocks: 50,
};

/**
 * The SIMULATED fixture replayed through the indexer: p1 settles, p2 refunds on timeout with a forfeited bond, p3 is never funded,
 * p4 is a direct x402 buy, p5 (a second seller) refunds on a proven mismatch with a forfeited bond.
 * `exclude` drops logs before replay (e.g. p3's PaidOut, to get a chain whose books can fully reconcile).
 */
export async function replayFixture(opts: { exclude?: ((log: RawLog) => boolean) | undefined } = {}) {
  const handle = await testDatabase();
  await fixtureMissionAndResource(handle.repos);
  const svc = createPurchaseService(handle.db);
  for (const id of ["resource-2", "resource-3", "resource-4", "resource-5"]) {
    await handle.repos.resources.insert({ ...(await handle.repos.resources.getById("resource-1"))!, id });
  }
  const terms = (purchaseId: string, orderId: `0x${string}`, escrowAddress: `0x${string}`, bondAtomic: string, sellerAddress: `0x${string}`) => ({
    purchaseId, orderIdBytes32: orderId, escrowAddress, sellerAddress, amountAtomic: FIXTURE.amount, bondAtomic,
    termsHash: b32(9), manifestHash: b32(5), rootPlain: b32(21), rootCipher: b32(22), keyCommitment: b32(23),
    revealDeadline: "1800000000", challengeWindow: "600", sourceKey: FIXTURE.owner, minTimestamp: "0", chunkCount: 7,
  });
  for (const [id, order, escrow, resourceId, bond, seller] of [
    ["p1", b32(1), FIXTURE.escrow1, "resource-1", "0", FIXTURE.seller],
    ["p2", b32(2), FIXTURE.escrow2, "resource-2", FIXTURE.bond, FIXTURE.seller],
    ["p3", b32(3), FIXTURE.escrow3, "resource-3", "0", FIXTURE.seller],
    ["p5", b32(4), FIXTURE.escrow4, "resource-5", FIXTURE.bond, FIXTURE.cheater],
  ] as const) {
    await svc.propose({ purchase: purchaseInput({ id, orderIdBytes32: order, escrowAddress: escrow, sellerAddress: seller, resourceId, idempotencyKey: `k-${id}` }), reason: "fixture", source: { kind: "oracle", reference: "test" } });
    await handle.repos.escrowOrders.insert(terms(id, order, escrow, bond, seller));
  }
  await svc.propose({
    purchase: purchaseInput({
      id: "p4", orderIdBytes32: b32(4), escrowAddress: FIXTURE.apiSeller, sellerAddress: FIXTURE.apiSeller, resourceId: "resource-4",
      idempotencyKey: "k-p4", amountAtomic: FIXTURE.apiAmount,
      allocations: [{ agentId: "agent-research", department: "research", amountAtomic: FIXTURE.apiAmount }],
    }),
    reason: "fixture: direct x402 API purchase (SIMULATED)",
    source: { kind: "oracle", reference: "test" },
  });
  for (const [id, digest] of [["p1", b32(0xd1)], ["p2", b32(0xd2)], ["p4", b32(0xd4)], ["p5", b32(0xd5)]] as const) {
    await svc.transition(id, "RESERVED", { reason: "signed", source: { kind: "adapter", reference: "t" }, authorizationDigest: digest });
    await svc.transition(id, "PAYMENT_PENDING", { reason: "sent", source: { kind: "adapter", reference: "t" }, authorizationDigest: digest });
  }
  const warnings: string[] = [];
  const logs = opts.exclude ? fixture.logs.filter((l) => !opts.exclude!(l)) : fixture.logs;
  const source = fakeLogSource(logs, BigInt(FIXTURE.head));
  const indexer = createIndexer({ db: handle.db, source, config, log: () => undefined, warn: (m) => warnings.push(m) });
  const tick = await indexer.tick();
  return { handle, source, indexer, tick, warnings };
}

