import { describe, expect, it } from "vitest";
import { resolveRecourseAccounts } from "./accounts.js";

// Anvil's public dev keys 2..5 (not secrets); used only to check parsing.
const K = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv => ({ AGENT_ROOT_KEY: K(2), RECOURSE_SELLER_KEYS: [K(3), K(4), K(5)].join(","), ...over });

describe("resolveRecourseAccounts", () => {
  it("resolves without RECOURSE_ANVIL_RUN: the flag only schedules the boot demo (index.ts)", () => {
    const r = resolveRecourseAccounts(env({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.accounts.sellerList).toHaveLength(3);
    expect(r.accounts.sellerList.map((a) => a.address)).toEqual([r.accounts.sellers.honest.address, r.accounts.sellers.ghost.address, r.accounts.sellers.swap.address]);
    expect(r.accounts.rootNode.address).not.toBe(r.accounts.sellers.honest.address);
  });

  it("keeps every refusal reason", () => {
    expect(resolveRecourseAccounts(env({ AGENT_ROOT_KEY: undefined }))).toEqual({ ok: false, reason: "AGENT_ROOT_KEY must be a 0x 64-hex key (the treasury root node key)" });
    expect(resolveRecourseAccounts(env({ RECOURSE_SELLER_KEYS: `${K(3)},${K(4)}` }))).toEqual({ ok: false, reason: "RECOURSE_SELLER_KEYS must hold exactly 3 comma-separated keys (honest, ghost, swap), got 2" });
    expect(resolveRecourseAccounts(env({ RECOURSE_SELLER_KEYS: `${K(3)},${K(4)},nope` }))).toEqual({ ok: false, reason: "RECOURSE_SELLER_KEYS entries must be 0x 64-hex keys" });
    expect(resolveRecourseAccounts(env({ RECOURSE_SELLER_KEYS: [K(2), K(4), K(5)].join(",") }))).toEqual({ ok: false, reason: "the root node key and the three seller keys must be distinct accounts" });
  });
});
