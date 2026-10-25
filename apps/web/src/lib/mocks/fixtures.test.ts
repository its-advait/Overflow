import { describe, expect, it } from "vitest";
import { buildTreeFromChunks, GoldenVectorsSchema } from "@overflow/recourse-crypto";
import vectorsJson from "@overflow/recourse-crypto/vectors.json";
import { EscrowDetailResponseSchema, EscrowListResponseSchema } from "@overflow/schemas";
import { createMockApi } from "../api/mock";
import * as fx from "./fixtures";

const V = GoldenVectorsSchema.parse(vectorsJson);

describe("mock fixtures", () => {
  it("every purchase's allocations sum to its price", () => {
    for (const p of fx.purchases) {
      const sum = p.allocations.reduce((a, x) => a + BigInt(x.amountAtomic), 0n);
      expect(sum, p.id).toBe(BigInt(p.amountAtomic));
    }
  });
  it("has a merged and a refused Fusion outcome, the refused one naming its failing rule", () => {
    const refused = fx.fusionOutcomes.find((o) => !o.merge)!;
    expect(fx.fusionOutcomes.some((o) => o.merge)).toBe(true);
    expect(refused.failingRules).toEqual(["license"]);
    expect(refused.reason).toMatch(/^No merge of .* on res-cpi-california: license \(/);
    expect(refused.checks.filter((c) => !c.passed).map((c) => c.rule)).toEqual(["license"]);
  });
  it("every merge check carries evidence and the decisions end with the no-payment sentence", () => {
    for (const o of fx.fusionOutcomes) expect(o.checks).toHaveLength(9);
    for (const d of fx.oracleDecisions) expect(d.summary.endsWith("This is a recommendation; it authorizes no payment.")).toBe(true);
  });
  it("ledger rows balance: every account's debits and credits sum to the same total", () => {
    let debits = 0n;
    let credits = 0n;
    for (const e of fx.ledgerEntries) {
      debits += BigInt(e.amountAtomic);
      credits += BigInt(e.amountAtomic);
    }
    expect(debits).toBe(credits);
    const treasury = fx.ledgerEntries.reduce(
      (n, e) => n + (e.debitAccount === "usdc-treasury" ? BigInt(e.amountAtomic) : 0n) - (e.creditAccount === "usdc-treasury" ? BigInt(e.amountAtomic) : 0n),
      0n,
    );
    expect(treasury.toString()).toBe(fx.reconciliationRun.treasuryLedgerAtomic);
  });
  it("the ok run checks every fixture escrow at zero difference; the planted run's difference is the exception's amount", () => {
    expect(fx.reconciliationRun.escrows.map((e) => e.purchaseId).sort()).toEqual(fx.escrows.map((e) => e.purchaseId).sort());
    for (const e of fx.reconciliationRun.escrows) {
      expect(e.differenceAtomic).toBe("0");
      expect(e.material).toBe(false);
      // Funded and Revealed orders carry a chain balance of line + bond; Created and closed ones read nothing.
      expect(e.chainAtomic !== undefined).toBe(e.status === "Funded" || e.status === "Revealed");
    }
    expect(fx.reconciliationRun.differences).toEqual([]);
    expect(fx.reconciliationRunPlanted.status).toBe("differences");
    const planted = fx.reconciliationRunPlanted.differences.find((d) => d.kind === "treasury")!;
    expect(planted.material).toBe(true);
    expect(planted.differenceAtomic).toBe(fx.plantedException.amountAtomic);
    expect(fx.reconciliationRunPlanted.exceptionIds).toEqual([fx.plantedException.id]);
    expect(fx.plantedException.subject).toBe(planted.subject);
  });

  it("chain transactions carry the built contracts' event arg names (escrow events have no orderId)", () => {
    const ARGS: Record<string, string[]> = {
      OrderCreated: ["escrow", "orderId", "buyer", "seller", "amount", "termsHash"],
      OrderFunded: ["balance"],
      KeyRevealed: ["key", "challengeEnd"],
      Accepted: ["signer", "nodeId"],
      PaidOut: ["seller", "amount", "bond"],
      Refunded: ["reason"],
      CheatProven: ["seller", "index"],
      Transfer: ["from", "to", "value"],
    };
    for (const t of fx.chainTransactions) expect(Object.keys(t.args).sort(), `${t.id} ${t.eventName}`).toEqual([...ARGS[t.eventName]!].sort());
    for (const e of fx.escrows) expect(fx.chainTransactions.some((t) => t.purchaseId === e.purchaseId && t.eventName === "OrderCreated"), e.id).toBe(true);
  });
  it("the three recourse orders carry the golden vectors: honest and ghost share the commitment, the swap order's rootCipher is the swapped tree", () => {
    const national = fx.escrows.find((e) => e.id === "esc-national")!;
    const freight = fx.escrows.find((e) => e.id === "esc-freight")!;
    const swap = fx.escrows.find((e) => e.id === "esc-ev-swap")!;
    for (const e of [national, freight, swap]) {
      expect(e.rootPlain).toBe(V.rootPlain);
      expect(e.keyCommitment).toBe(V.keyCommitment);
      expect(e.chunkCount).toBe(7);
    }
    expect(national.rootCipher).toBe(V.rootCipher);
    expect(swap.rootCipher).toBe(buildTreeFromChunks(V.chunks.map((c, i) => (i === 3 ? V.swappedChunk.cipher : c.cipher))).root);
    expect(national.revealedKey).toBe(V.perBuyerKey);
    // The ghost never revealed: no key, no KeyRevealed log, no flag; refunded for the timeout.
    expect(freight.revealedKey).toBeUndefined();
    expect(freight.refundReason).toBe("timeout");
    expect(fx.chainTransactions.some((t) => t.purchaseId === freight.purchaseId && t.eventName === "KeyRevealed")).toBe(false);
    expect(fx.activity.some((a) => a.purchaseId === freight.purchaseId && a.kind === "seller.flagged")).toBe(false);
    // The swap seller: proven complaint on chunk 3, CheatProven log, flagged.
    expect(fx.complaintByPurchase(swap.purchaseId)).toMatchObject({ status: "proven", chunkIndex: 3, cheatVerified: true });
    expect(fx.chainTransactions.some((t) => t.purchaseId === swap.purchaseId && t.eventName === "CheatProven")).toBe(true);
    expect(fx.activity.some((a) => a.purchaseId === swap.purchaseId && a.kind === "seller.flagged")).toBe(true);
    expect(fx.sampleByPurchase(swap.purchaseId)!.indices).not.toContain(3);
  });
  it("the swap order's books net to zero and book the forfeited bond as other income", () => {
    const rows = fx.ledgerEntries.filter((e) => e.purchaseId === "pur-ev-swap");
    const deposit = rows.reduce((n, e) => n + (e.debitAccount === "escrow-deposit" ? BigInt(e.amountAtomic) : 0n) - (e.creditAccount === "escrow-deposit" ? BigInt(e.amountAtomic) : 0n), 0n);
    expect(deposit).toBe(0n);
    expect(rows.find((e) => e.creditAccount === "other-income-seller-forfeiture")?.amountAtomic).toBe("1000000");
  });
  it("the mock client's escrow list and every detail parse with the service's response schemas", async () => {
    const api = createMockApi();
    const list = EscrowListResponseSchema.parse(await api.listEscrows());
    expect(list.escrows.map((e) => e.status).sort()).toEqual(["Created", "Funded", "Refunded", "Refunded", "Revealed", "Settled"]);
    for (const row of list.escrows) {
      const detail = EscrowDetailResponseSchema.parse(await api.getEscrow(row.purchaseId));
      expect(detail.simulated).toBe(true);
      expect(detail.chain?.status).toBe(row.status);
      expect(detail.actions?.asOf).toBe(detail.chain?.blockTimestamp);
    }
    const swap = await api.getEscrow("pur-ev-swap");
    expect(swap.complaint?.status).toBe("proven");
    expect(Object.values(swap.actions!).filter((g) => typeof g === "object" && g.allowed)).toEqual([]);
    const oregon = await api.getEscrow("pur-oregon-monthly");
    expect(oregon.actions).toMatchObject({ accept: { allowed: true }, finalizePayout: { allowed: false }, complain: { allowed: false } });
    const weather = await api.getEscrow((await api.getEscrow("pur-weather-daily")).escrow.escrowAddress.toLowerCase());
    expect(weather.actions?.claimTimeoutRefund.allowed).toBe(false);
  });
});
