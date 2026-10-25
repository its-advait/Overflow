import type { ActivityEvent } from "@overflow/schemas";
import { describe, expect, it } from "vitest";
import { expectedOutcome, fusionDecisions, orderedTxs, parseFusionDecision } from "./index";

// The exact strings the service wrote during the live Anvil run (docs/PROGRESS.md "judge controls API").
const MERGE_MSG = "Merge: all 9 rules pass for 3c759b27-ac57-46f6-b39f-ad3653e15ac6, f9b2e7e0-46a3-4b9b-a260-0006ad41a71a on listing-national-monthly-2024-2026-seller-b. lowest common ancestor agent-orchestrator and its ancestors have no onchain node; mission root node 1 pays.";
const NO_MERGE_MSG = "No merge of 3c759b27-ac57-46f6-b39f-ad3653e15ac6, f9b2e7e0-46a3-4b9b-a260-0006ad41a71a on listing-california-monthly-2024-2026: geography (missing region(s) US; listing covers US-CA). Requests stay separate.";
const TWO_RULES_MSG = "No merge of req-a, req-b on listing-national-monthly-2024-2026-single-user: license (single-user, 1 seats for 2 agents); price (no saving: one purchase 10.00 USDC vs 9.00 USDC separately (4.00 + 5.00), caps 22.00 USDC). Request(s) req-b wait: listing-national-monthly-2024-2026-single-user cannot be shared and one active purchase per mission and resource exists; a second seat needs its own order once this one settles.";
const NO_LISTING_MSG = "No merge of 75cb953b-c07b-4bcb-a5b1-043e097d1508, b18f8b20-36ef-4144-a9d1-24c84a1b8542: no listing satisfies any of these requests. Requests stay separate.";

describe("parseFusionDecision", () => {
  it("reads a merge and the listing it landed on", () => {
    expect(parseFusionDecision(MERGE_MSG)).toEqual({ verdict: "merge", listingId: "listing-national-monthly-2024-2026-seller-b", failingRules: [], reason: "Merge: all 9 rules pass for 3c759b27-ac57-46f6-b39f-ad3653e15ac6, f9b2e7e0-46a3-4b9b-a260-0006ad41a71a on listing-national-monthly-2024-2026-seller-b" });
  });
  it("reads a no-merge with its failing rules in Fusion's order", () => {
    expect(parseFusionDecision(NO_MERGE_MSG)).toMatchObject({ verdict: "no-merge", listingId: "listing-california-monthly-2024-2026", failingRules: ["geography"] });
    expect(parseFusionDecision(TWO_RULES_MSG)).toMatchObject({ verdict: "no-merge", listingId: "listing-national-monthly-2024-2026-single-user", failingRules: ["license", "price"] });
    expect(parseFusionDecision(TWO_RULES_MSG).reason).not.toContain("Request(s)");
  });
  it("reads the no-listing case and leaves anything else untouched", () => {
    expect(parseFusionDecision(NO_LISTING_MSG)).toMatchObject({ verdict: "no-merge", listingId: null, failingRules: [] });
    expect(parseFusionDecision("something the service never wrote")).toEqual({ verdict: "none", listingId: null, failingRules: [], reason: "something the service never wrote" });
  });
});

describe("fusionDecisions", () => {
  const ev = (id: string, at: string, kind: ActivityEvent["kind"]): ActivityEvent => ({ id, at, kind, message: id, missionId: "m", simulated: true });
  it("keeps only fusion.decision rows, newest first (the service lists a mission's activity oldest first)", () => {
    const rows = [ev("a", "2026-10-25T12:50:08.574Z", "fusion.decision"), ev("x", "2026-10-25T12:50:09.000Z", "oracle.recommendation"), ev("b", "2026-10-25T12:50:43.350Z", "fusion.decision"), ev("c", "2026-10-25T12:50:44.441Z", "fusion.decision")];
    expect(fusionDecisions(rows).map((e) => e.id)).toEqual(["c", "b", "a"]);
    expect(fusionDecisions(rows, 2).map((e) => e.id)).toEqual(["c", "b"]);
  });
});

describe("orders copy", () => {
  it("names the refund for ghost and swap and the payout for honest, each ending in the indexer's status", () => {
    expect(expectedOutcome("ghost")).toMatch(/claimTimeoutRefund.*REFUNDED/);
    expect(expectedOutcome("swap")).toMatch(/complainMismatch.*REFUNDED/);
    expect(expectedOutcome("honest")).toMatch(/PaidOut.*SETTLED/);
  });
  it("orders the runner's transactions as they happen", () => {
    const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
    expect(orderedTxs({ claimTimeoutRefund: h(5), create: h(1), settle: h(3), bond: h(2), markFunded: h(4), extra: h(9) }).map((t) => t.label)).toEqual(["create", "bond", "settle", "markFunded", "claimTimeoutRefund", "extra"]);
  });
});
