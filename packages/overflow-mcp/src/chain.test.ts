import { describe, expect, it } from "vitest";
import { effectivePolicy, predictRefusal } from "./chain";
import { ATTACKER, defaultChain, fakeChain, node, NODE_ACCOUNT, NOW, SEARCH_PAYEE, USDC_6 } from "./test-fixtures";

const key = NODE_ACCOUNT.address.toLowerCase();

describe("effectivePolicy mirrors _authorize step 5 and remaining()", () => {
  it("root only: remaining = cap - spent, per-call = maxPerCall", async () => {
    const p = await effectivePolicy(defaultChain(), NODE_ACCOUNT.address, NOW);
    expect(p).toMatchObject({ nodeId: "1", remainingAtomic: (40n * USDC_6).toString(), remainingUsdc: "40.00", perCallAtomic: (15n * USDC_6).toString(), perCallUsdc: "15.00", blocked: null });
    expect(p.nodes.map((n) => n.id)).toEqual(["1"]);
  });

  it("depth 2: the walk ends at parent 0; per-call is the minimum maxPerCall up the tree; remaining the minimum headroom", async () => {
    const chain = fakeChain({
      nodes: {
        "1": node({ key: SEARCH_PAYEE, maxPerCall: 15n * USDC_6, cap: 50n * USDC_6, spent: 45n * USDC_6 }),
        "2": node({ key: ATTACKER, parent: 1n, depth: 1n, maxPerCall: 8n * USDC_6, cap: 20n * USDC_6, spent: 0n }),
        "3": node({ parent: 2n, depth: 2n, maxPerCall: 5n * USDC_6, cap: 10n * USDC_6, spent: 1n * USDC_6 }),
      },
      keys: { [key]: 3n },
      allowlist: [],
    });
    const p = await effectivePolicy(chain, NODE_ACCOUNT.address, NOW);
    expect(p.nodes.map((n) => n.id)).toEqual(["3", "2", "1"]);
    expect(p.perCallAtomic).toBe((5n * USDC_6).toString());
    expect(p.remainingAtomic).toBe((5n * USDC_6).toString()); // the root has 5 USDC left
    expect(p.blocked).toBeNull();
  });

  it("an unregistered key is UnknownAgent with zero budget", async () => {
    const p = await effectivePolicy(defaultChain({ keys: {} }), NODE_ACCOUNT.address, NOW);
    expect(p.nodeId).toBeNull();
    expect(p.blocked?.name).toBe("UnknownAgent");
    expect(p.remainingAtomic).toBe("0");
  });

  it("a paused or expired ancestor blocks everything, reported in the contract's walk order", async () => {
    const paused = fakeChain({ nodes: { "1": node({ paused: true, key: SEARCH_PAYEE }), "2": node({ parent: 1n, depth: 1n }) }, keys: { [key]: 2n }, allowlist: [] });
    expect((await effectivePolicy(paused, NODE_ACCOUNT.address, NOW)).blocked).toMatchObject({ name: "Paused", args: ["1"], decoded: "Paused(1)" });
    const expired = fakeChain({ nodes: { "1": node({ expiry: BigInt(NOW) }) }, keys: { [key]: 1n }, allowlist: [] });
    const e = await effectivePolicy(expired, NODE_ACCOUNT.address, NOW);
    expect(e.blocked).toMatchObject({ name: "Expired", args: ["1"] });
    expect(e.nodes[0]!.expired).toBe(true);
  });
});

describe("predictRefusal mirrors the amount and payee checks", () => {
  it("names the first node that would revert", async () => {
    const chain = defaultChain({ nodeAllow: { "1": [SEARCH_PAYEE] } });
    const p = await effectivePolicy(chain, NODE_ACCOUNT.address, NOW);
    expect(await predictRefusal(chain, p, 20_000n, SEARCH_PAYEE, true)).toBeNull();
    expect(await predictRefusal(chain, p, 20_000n, ATTACKER, false)).toMatchObject({ name: "PayeeNotAllowed", args: ["0"], reason: "Recipient is not approved for anyone" });
    expect(await predictRefusal(chain, p, 16n * USDC_6, SEARCH_PAYEE, true)).toMatchObject({ name: "OverPerCall", args: ["1"] });
    const tight = fakeChain({ nodes: { "1": node({ cap: 50n * USDC_6, spent: 49n * USDC_6, maxPerCall: 50n * USDC_6 }) }, keys: { [key]: 1n }, allowlist: [SEARCH_PAYEE] });
    expect(await predictRefusal(tight, await effectivePolicy(tight, NODE_ACCOUNT.address, NOW), 2n * USDC_6, SEARCH_PAYEE, true)).toMatchObject({ name: "OverBudget", args: ["1"] });
    const restricted = fakeChain({ nodes: { "1": node({ restricted: true }) }, keys: { [key]: 1n }, allowlist: [SEARCH_PAYEE, ATTACKER], nodeAllow: { "1": [SEARCH_PAYEE] } });
    const rp = await effectivePolicy(restricted, NODE_ACCOUNT.address, NOW);
    expect(await predictRefusal(restricted, rp, 1n, ATTACKER, true)).toMatchObject({ name: "PayeeNotAllowed", args: ["1"] });
    expect(await predictRefusal(restricted, rp, 1n, SEARCH_PAYEE, true)).toBeNull();
  });
});
