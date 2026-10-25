import { answerKey } from "../answer-key.js";
import { createChild, createRoot, ownerWrite, pay, type ProofContext } from "../context.js";
import { defineCase } from "../types.js";
import { revertCheck } from "./helpers.js";

export default defineCase({
  ...answerKey(7),
  slug: "paused-root",
  onchain: true,
  live: { kind: "onchain", needs: { relayerTxs: 2, ownerTxs: 2, sellerTxs: 0, treasuryUsdc: 0n } },
  setup: async (ctx: ProofContext) => {
    const root = await createRoot(ctx, { cap: 5_000_000n, maxPerCall: 1_000_000n });
    const child = await createChild(ctx, root, { cap: 1_000_000n, maxPerCall: 100_000n });
    await ownerWrite(ctx, "pause", [root.id], "owner pause(orchestrator root)");
    return { root, child };
  },
  action: async (ctx, s) => ({ ...(await pay(ctx, s.child, ctx.payees.search, 20_000n, "child pays while root paused (forced broadcast)")), root: s.root.id }),
  check: (_ctx, o) => revertCheck(o.sent, { name: "Paused", args: [o.root.toString()] }, ` (root = node ${o.root})`),
});
