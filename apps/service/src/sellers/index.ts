/**
 * SIMULATED sellers. Nothing here is a real marketplace; everything served from
 * this module is labeled "simulated" in code, UI and docs.
 */
export * from "./app.js";
export * from "./config.js";
export * from "./direct-order.js";
export * from "./listing.js";
export * from "./paywall.js";
export * from "./prices.js";
export * from "./providers.js";
export * from "./recourse/index.js";

import type { SellerConfig } from "./config.js";

export function sellersStatus(config: SellerConfig, facilitatorOk: boolean, recourseStatus?: string): string {
  return [
    `SIMULATED sellers on ${config.sellerUrl}`,
    `search provider ${config.contextDevKey ? "context.dev" : "canned"}`,
    `payees from ${config.payeeSource}`,
    config.attacker ? "attacker fixture configured (never allowlisted)" : "attacker fixture disabled (ATTACKER_ADDRESS unset)",
    facilitatorOk ? "settles via treasury.settle()" : "facilitator unavailable: paid retries answer 503",
    recourseStatus ?? "SIMULATED Recourse sellers idle (SELLER_KEYS empty)",
  ].join("; ");
}
