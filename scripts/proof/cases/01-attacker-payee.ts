import { answerKey } from "../answer-key.js";
import { createRoot, pay, usdcBalance, type ProofContext } from "../context.js";
import { defineCase } from "../types.js";
import { relayerOnly, revertCheck } from "./helpers.js";

// The SIMULATED injected listing names the SIMULATED attacker as payee; the agent's node signs; settle() refuses.
export default defineCase({
  ...answerKey(1),
  slug: "attacker-payee",
  onchain: true,
  live: relayerOnly(1),
  setup: async (ctx: ProofContext) => ({ node: await createRoot(ctx, { cap: 5_000_000n, maxPerCall: 1_000_000n }) }),
  action: async (ctx, s) => {
    const before = await usdcBalance(ctx, ctx.payees.attacker);
    const r = await pay(ctx, s.node, ctx.payees.attacker, 50_000n, "settle to SIMULATED attacker (forced broadcast)");
    return { ...r, before, after: await usdcBalance(ctx, ctx.payees.attacker) };
  },
  check: (_ctx, o) => {
    const c = revertCheck(o.sent, { name: "PayeeNotAllowed", args: ["0"] }, `; attacker USDC ${o.before} -> ${o.after}`);
    return { ...c, pass: c.pass && o.after === o.before };
  },
});
