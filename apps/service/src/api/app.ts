import { randomUUID } from "node:crypto";
import { createRepositories, type Db } from "@overflow/database";
import { CHAIN_ID } from "@overflow/schemas";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createPurchaseService } from "../orchestration/purchase-service.js";
import type { ApiDeps } from "./deps.js";
import { ApiError, errorResponse, type ApiEnv } from "./http.js";
import { defaultPorts, type Ports } from "./ports.js";
import { activityRoutes } from "./routes/activity.js";
import { agentRoutes } from "./routes/agents.js";
import { escrowRoutes } from "./routes/escrow.js";
import { ledgerRoutes } from "./routes/ledger.js";
import { missionRoutes } from "./routes/missions.js";
import { purchaseRoutes } from "./routes/purchases.js";
import { resourceRoutes } from "./routes/resources.js";
import { resolveSession, type Session } from "./session.js";

export interface CreateAppOptions {
  db: Db;
  ports?: Partial<Ports> | undefined;
  session?: Session | undefined;
  /** Extra fields for GET / (database dialect etc.). */
  status?: Record<string, unknown> | undefined;
}

/**
 * The REST API of docs/SPEC.md "API". There is no /api/execute and no route
 * accepts calldata, ABI-encoded data or raw transactions: agents propose and
 * sign; only the contracts move USDC.
 */
export function createApp(opts: CreateAppOptions) {
  const base = defaultPorts();
  const deps: ApiDeps = {
    db: opts.db,
    repos: createRepositories(opts.db),
    purchases: createPurchaseService(opts.db),
    ports: {
      orchestration: opts.ports?.orchestration ?? base.orchestration,
      adapters: opts.ports?.adapters ?? base.adapters,
      policy: opts.ports?.policy ?? base.policy,
      reconciliation: opts.ports?.reconciliation ?? base.reconciliation,
    },
    session: opts.session ?? resolveSession(),
  };

  const app = new Hono<ApiEnv>();
  app.use("*", cors({ origin: "*", allowHeaders: ["content-type", "idempotency-key"], allowMethods: ["GET", "POST", "OPTIONS"] }));
  app.use("*", async (c, next) => {
    c.set("requestId", c.req.header("x-request-id") ?? randomUUID());
    c.set("session", deps.session);
    await next();
  });
  app.onError((e, c) => errorResponse(c, e));
  app.notFound((c) => errorResponse(c, new ApiError(404, "route_not_found", `${c.req.method} ${c.req.path} is not a route`)));

  app.get("/", (c) =>
    c.json({
      service: "@overflow/service",
      scaffold: false,
      chainId: CHAIN_ID,
      session: { organizationId: deps.session.organizationId, principal: deps.session.principal },
      ...opts.status,
    }),
  );

  app.route("/api/missions", missionRoutes(deps));
  app.route("/api/resources", resourceRoutes(deps));
  app.route("/api/purchases", purchaseRoutes(deps));
  app.route("/api/escrow", escrowRoutes(deps));
  app.route("/api/agents", agentRoutes(deps));
  app.route("/api/activity", activityRoutes(deps));
  app.route("/api", ledgerRoutes(deps));

  return { app, deps };
}
export type Api = ReturnType<typeof createApp>;
