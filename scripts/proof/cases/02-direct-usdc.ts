import { answerKey } from "../answer-key.js";
import { authorizationUsed, createRoot, directToUsdc, newKey, pay, setEth, usdcBalance, type ProofContext } from "../context.js";
import { defineCase } from "../types.js";
import { relayerOnly, revertCheck } from "./helpers.js";

// The attacker takes the agent's signature (refused by the treasury) and sends it straight to USDC: USDC asks the
// treasury via ERC-1271, the gate is closed outside settle(), so FiatTokenV2 reverts.
export default defineCase({
  ...answerKey(2),
  slug: "direct-usdc",
  onchain: true,
  live: relayerOnly(2),
  setup: async (ctx: ProofContext) => {
    const node = await createRoot(ctx, { cap: 5_000_000n, maxPerCall: 1_000_000n });
    const attacker = newKey(); // SIMULATED attacker submitter (fork-only key)
    await setEth(ctx, attacker.address);
    return { node, attacker };
  },
  action: async (ctx, s) => {
    const first = await pay(ctx, s.node, ctx.payees.attacker, 50_000n, "settle to SIMULATED attacker (forced broadcast)");
    const sent = await directToUsdc(ctx, s.attacker, first.signed, "same signature straight to USDC.transferWithAuthorization (forced broadcast)");
    return { sent, nonceUsed: await authorizationUsed(ctx, first.signed.authorization.nonce), attackerUsdc: await usdcBalance(ctx, ctx.payees.attacker) };
  },
  check: (_ctx, o) => {
    const c = revertCheck(o.sent, { name: "Error", args: ["FiatTokenV2: invalid signature"] }, `; nonce used: ${o.nonceUsed}; attacker USDC ${o.attackerUsdc}`);
    return { ...c, pass: c.pass && !o.nonceUsed && o.attackerUsdc === 0n };
  },
});
