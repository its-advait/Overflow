import { answerKey } from "../answer-key.js";
import { createChild, createRoot, pay, type ProofContext } from "../context.js";
import { defineCase } from "../types.js";
import { relayerOnly, revertCheck } from "./helpers.js";

// A restricted child may pay only the SIMULATED search seller; it tries the (globally allowlisted) scraping seller.
export default defineCase({
  ...answerKey(3),
  slug: "search-only-scrape",
  onchain: true,
  live: relayerOnly(2),
  setup: async (ctx: ProofContext) => {
    const root = await createRoot(ctx, { cap: 5_000_000n, maxPerCall: 1_000_000n });
    const child = await createChild(ctx, root, { cap: 1_000_000n, maxPerCall: 100_000n, restricted: true, payees: [ctx.payees.search] });
    return { child };
  },
  action: async (ctx, s) => ({ ...(await pay(ctx, s.child, ctx.payees.scrape, 50_000n, "search-only child pays scrape seller (forced broadcast)")), child: s.child.id }),
  check: (_ctx, o) => revertCheck(o.sent, { name: "PayeeNotAllowed", args: [o.child.toString()] }, ` (n = search-only child node ${o.child})`),
});
