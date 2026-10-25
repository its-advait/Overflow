import { answerKey } from "../answer-key.js";
import { createChild, createRoot, pay, type ProofContext } from "../context.js";
import { defineCase } from "../types.js";
import { relayerOnly, revertCheck } from "./helpers.js";

export default defineCase({
  ...answerKey(4),
  slug: "over-per-call",
  onchain: true,
  live: relayerOnly(2),
  setup: async (ctx: ProofContext) => {
    const root = await createRoot(ctx, { cap: 5_000_000n, maxPerCall: 1_000_000n });
    return { child: await createChild(ctx, root, { cap: 1_000_000n, maxPerCall: 40_000n }) };
  },
  action: async (ctx, s) => ({ ...(await pay(ctx, s.child, ctx.payees.scrape, 50_000n, "0.05 USDC from a 0.04 per-call node (forced broadcast)")), child: s.child.id }),
  check: (_ctx, o) => revertCheck(o.sent, { name: "OverPerCall", args: [o.child.toString()] }, ` (n = node ${o.child}, maxPerCall 0.04 USDC, value 0.05 USDC)`),
});
