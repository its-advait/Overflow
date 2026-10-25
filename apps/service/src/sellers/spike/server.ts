/**
 * SPIKE, THROWAWAY: a seller with one paid route ($0.01 USDC on Base Sepolia) on the official x402 v2 seller
 * middleware (@x402/hono), configured for Coinbase's CDP facilitator (SPIKE_FACILITATOR=cdp, CDP_API_KEY_ID /
 * CDP_API_KEY_SECRET) or the public x402.org facilitator (SPIKE_FACILITATOR=public). Used only by
 * scripts/coinbase-spike.ts to learn whether the facilitator settles a payment whose payer is our treasury.
 * Not part of the demo; nothing here is a real marketplace.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { loadEnv } from "../../config";

loadEnv();
const which = process.env["SPIKE_FACILITATOR"] ?? "cdp";
const payTo = (process.env["SPIKE_PAY_TO"] ?? process.env["DEMO_PAYEE_ADDRESS"] ?? "0x1111111111111111111111111111111111111111") as `0x${string}`;
const port = Number(process.env["SPIKE_SELLER_PORT"] ?? 4402);

const facilitatorConfig =
  which === "public"
    ? { url: "https://x402.org/facilitator" }
    : createFacilitatorConfig(process.env["CDP_API_KEY_ID"], process.env["CDP_API_KEY_SECRET"]); // auth headers built per request; never logged
const facilitator = new HTTPFacilitatorClient(facilitatorConfig);
console.log(`[spike seller] facilitator ${which} at ${facilitator.url}, payTo ${payTo}, CDP key ${process.env["CDP_API_KEY_ID"] ? "present" : "absent"}`);

const app = new Hono();
app.use(
  paymentMiddlewareFromConfig(
    {
      "GET /spike/report": {
        accepts: { scheme: "exact", network: "eip155:84532", price: "$0.01", payTo, maxTimeoutSeconds: 300 },
        description: "SPIKE: one paid route to test a policy-wallet payer against Coinbase's facilitator",
        mimeType: "application/json",
      },
    },
    [facilitator],
    [{ network: "eip155:84532", server: new ExactEvmScheme() }],
  ),
);
app.get("/spike/report", (c) => c.json({ report: "SPIKE resource: paid for through the facilitator", simulated: true }));
app.get("/", (c) => c.json({ spike: true, facilitator: which, facilitatorUrl: facilitator.url, payTo }));

serve({ fetch: app.fetch, port }, (info) => console.log(`[spike seller] listening on http://localhost:${info.port}`));
