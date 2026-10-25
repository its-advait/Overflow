import type { Db, Repositories } from "@overflow/database";
import type { PurchaseService } from "../orchestration/purchase-service.js";
import type { Ports } from "./ports.js";
import type { Session } from "./session.js";

/** Everything the routes need, built once in createApp. */
export interface ApiDeps {
  db: Db;
  repos: Repositories;
  purchases: PurchaseService;
  ports: Ports;
  session: Session;
}
