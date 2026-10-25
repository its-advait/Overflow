import { Hono } from "hono";
import type { FacilitatorDeps } from "./context";
import { shortMessage } from "./decode";
import { delegationRoutes } from "./routes/delegations";
import { demoRoutes } from "./routes/demo";
import { eventRoutes } from "./routes/events";
import { paymentRoutes } from "./routes/payments";

/** The facilitator: relays signed agent messages; never holds USDC or the owner key; no /admin routes. */
export function createFacilitatorApp(deps: FacilitatorDeps, opts: { heartbeatMs?: number } = {}) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("access-control-allow-origin", "*");
    c.header("access-control-allow-headers", "content-type, x-demo-token, idempotency-key");
    c.header("access-control-allow-methods", "GET, POST, OPTIONS");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
  });
  app.route("/", paymentRoutes(deps));
  app.route("/", delegationRoutes(deps));
  app.route("/", eventRoutes(deps, opts.heartbeatMs));
  if (deps.demoMode) app.route("/", demoRoutes(deps));
  app.notFound((c) => c.json({ ok: false, error: { name: "NotFound", reason: `${c.req.method} ${c.req.path}` } }, 404));
  app.onError((err, c) => {
    deps.log(`[facilitator] ${c.req.method} ${c.req.path} failed: ${shortMessage(err)}`);
    return c.json({ ok: false, error: { name: "InternalError", reason: shortMessage(err) } }, 500);
  });
  return app;
}
