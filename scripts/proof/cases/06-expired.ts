import { answerKey } from "../answer-key.js";
import { advanceTo, createChild, createRoot, nowSeconds, pay, type ProofContext } from "../context.js";
import { defineCase } from "../types.js";
import { revertCheck } from "./helpers.js";

export default defineCase({
  ...answerKey(6),
  slug: "expired",
  onchain: true,
  live: { kind: "skip", reason: "fork-only in this build (needs chain time to pass the node's expiry)" },
  setup: async (ctx: ProofContext) => {
    const root = await createRoot(ctx, { cap: 5_000_000n, maxPerCall: 1_000_000n });
    const expiry = BigInt(nowSeconds(ctx) + 60);
    return { child: await createChild(ctx, root, { cap: 1_000_000n, maxPerCall: 100_000n, expiry }), expiry };
  },
  action: async (ctx, s) => {
    await advanceTo(ctx, s.expiry + 1n);
    return { ...(await pay(ctx, s.child, ctx.payees.search, 20_000n, "payment after expiry (forced broadcast)")), child: s.child.id };
  },
  check: (_ctx, o) => revertCheck(o.sent, { name: "Expired", args: [o.child.toString()] }, ` (n = node ${o.child})`),
});
