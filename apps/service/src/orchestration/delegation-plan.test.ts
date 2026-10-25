import { ChildParamsSchema, createChildDigest, signCreateChild, signPauseChild, pauseChildDigest } from "@overflow/payment-client";
import { keccak256, toBytes, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ATTACKER, TREASURY } from "../test-db.js";
import { childParamsFor, resolveRolePolicies, ROLES, splitBudget, type TreasuryNode } from "./delegation-plan.js";

const SEARCH = "0x2222222222222222222222222222222222222222" as const;
const SCRAPE = "0x3333333333333333333333333333333333333333" as const;
const ROOT = privateKeyToAccount(keccak256(toBytes("overflow.test.root")));
const NOW = 1_800_000_000;
const rootNode: TreasuryNode = { key: ROOT.address, parent: 0n, depth: 0n, cap: 50_000_000n, spent: 0n, maxPerCall: 15_000_000n, expiry: BigInt(NOW + 7 * 86_400), paused: false, restricted: false };

describe("delegation plan", () => {
  const policies = resolveRolePolicies({ search: SEARCH, scrape: SCRAPE }, {}, ATTACKER);

  it("splits the budget in integer basis points and leaves the remainder with the orchestrator", () => {
    const shares = splitBudget(5_000_001n, policies);
    expect(shares.research).toBe(2_000_000n);
    expect(shares.finance).toBe(2_000_000n);
    expect(shares.verification).toBe(1_000_000n);
    expect(ROLES.reduce((s, r) => s + shares[r], 0n) <= 5_000_001n).toBe(true);
  });

  it("refuses the SIMULATED attacker as a payee and over-allocated shares", () => {
    expect(() => resolveRolePolicies({ search: SEARCH, scrape: SCRAPE }, { ORCHESTRATION_PAYEES_FINANCE: ATTACKER }, ATTACKER)).toThrow(/attacker/);
    expect(() => resolveRolePolicies({ search: SEARCH, scrape: SCRAPE }, { ORCHESTRATION_BPS_FINANCE: "7000" }, null)).toThrow(/10000/);
  });

  it("clamps every child limit inside the root's and signs a CreateChild the treasury can verify", async () => {
    const c = ChildParamsSchema.parse(childParamsFor({ parentNodeId: 1n, key: SEARCH, share: 60_000_000n, policy: policies.finance, root: rootNode, nowSeconds: NOW, nonce: "7" }));
    expect(BigInt(c.cap)).toBe(50_000_000n);
    expect(BigInt(c.maxPerCall)).toBe(15_000_000n);
    expect(BigInt(c.expiry)).toBe(BigInt(NOW + 86_400));
    expect(c.restricted).toBe(true);
    expect(c.deadline).toBe(String(NOW + 600));
    const sig = await signCreateChild(ROOT, TREASURY, c);
    const ok = await verifyTypedData({ address: ROOT.address, domain: { name: "Overflow", version: "1", chainId: 84532, verifyingContract: TREASURY }, types: { CreateChild: [
      { name: "parentId", type: "uint256" }, { name: "key", type: "address" }, { name: "cap", type: "uint256" }, { name: "maxPerCall", type: "uint256" }, { name: "expiry", type: "uint256" }, { name: "restricted", type: "bool" }, { name: "payeesHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" } ] },
      primaryType: "CreateChild", message: { parentId: 1n, key: SEARCH, cap: 50_000_000n, maxPerCall: 15_000_000n, expiry: BigInt(c.expiry), restricted: true, payeesHash: keccak256("0x"), nonce: 7n, deadline: BigInt(c.deadline) }, signature: sig });
    expect(ok).toBe(true);
    expect(createChildDigest(TREASURY, c)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses to delegate from a paused or expired root, or with an empty share", () => {
    const base = { parentNodeId: 1n, key: SEARCH, share: 1_000_000n, policy: policies.research, nowSeconds: NOW };
    expect(() => childParamsFor({ ...base, root: { ...rootNode, paused: true } })).toThrow(/paused/);
    expect(() => childParamsFor({ ...base, root: { ...rootNode, expiry: BigInt(NOW) } })).toThrow(/expired/);
    expect(() => childParamsFor({ ...base, root: rootNode, share: 0n })).toThrow(/positive/);
    expect(BigInt(childParamsFor({ ...base, root: { ...rootNode, expiry: BigInt(NOW + 600) } }).expiry)).toBe(BigInt(NOW + 540));
  });

  it("PauseChild is signed by the ancestor and hashes deterministically", async () => {
    const p = { target: "3", nonce: "9", deadline: String(NOW + 600) };
    const sig = await signPauseChild(ROOT, TREASURY, p);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(pauseChildDigest(TREASURY, p)).toBe(pauseChildDigest(TREASURY, { ...p }));
  });
});
