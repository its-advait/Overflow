import { answerKey } from "../answer-key.js";
import { createChild, createRoot, pay, type ProofContext } from "../context.js";
import { defineCase } from "../types.js";
import { relayerOnly, revertCheck } from "./helpers.js";

// Parent P (cap 0.08) has two sub-agents (cap 0.05 each). The first pays 0.05; the second's 0.05 would take P to 0.10.
export default defineCase({
  ...answerKey(5),
  slug: "over-budget-parent",
  onchain: true,
  live: relayerOnly(5),
  setup: async (ctx: ProofContext) => {
    const root = await createRoot(ctx, { cap: 5_000_000n, maxPerCall: 1_000_000n });
    const parent = await createChild(ctx, root, { cap: 80_000n, maxPerCall: 50_000n });
    const g1 = await createChild(ctx, parent, { cap: 50_000n, maxPerCall: 50_000n });
    const g2 = await createChild(ctx, parent, { cap: 50_000n, maxPerCall: 50_000n });
    return { parent, g1, g2 };
  },
  action: async (ctx, s) => {
    const first = await pay(ctx, s.g1, ctx.payees.scrape, 50_000n, "sub-agent 1 pays 0.05", false);
    const second = await pay(ctx, s.g2, ctx.payees.scrape, 50_000n, "sub-agent 2 pays 0.05 (forced broadcast)");
    return { first: first.sent, sent: second.sent, parent: s.parent.id };
  },
  check: (_ctx, o) => {
    const c = revertCheck(o.sent, { name: "OverBudget", args: [o.parent.toString()] }, `; sub-agent 1 paid in ${o.first.hash} (${o.first.status}) (parent = node ${o.parent})`);
    return { ...c, pass: c.pass && o.first.status === "success" };
  },
});
