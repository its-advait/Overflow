import type { Db, Repositories } from "@overflow/database";
import type { Address } from "@overflow/schemas";
import type { ActivityBus, IndexerStatus } from "../chain/bus.js";
import type { ExceptionService } from "../exceptions/service.js";
import type { PurchaseFlow } from "../orchestration/purchase-flow.js";
import type { PurchaseService } from "../orchestration/purchase-service.js";
import type { Ports } from "./ports.js";
import type { Session } from "./session.js";

/** Everything the routes need, built once in createApp. */
export interface ApiDeps {
  db: Db;
  repos: Repositories;
  purchases: PurchaseService;
  /** Typed "ask a human" cases and their prepared controller requests. */
  exceptions: ExceptionService;
  /** Steps 4 to 7 (sample judgment, quote, sign, submit) over the ports below. */
  flow: PurchaseFlow;
  ports: Ports;
  session: Session;
  /** Live feed every committed activity event is published on. */
  bus: ActivityBus;
  /** Real indexer state for GET /events and GET /; idle with a reason when no indexer runs. */
  indexerStatus: () => IndexerStatus;
  /** The deployed treasury, or null when no deployment is configured. Never invented. */
  treasury: Address | null;
}
