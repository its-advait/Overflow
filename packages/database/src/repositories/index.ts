import type { Executor } from "../client";
import { activityEventsRepository } from "./activity-events";
import { agentsRepository } from "./agents";
import { chainTransactionsRepository } from "./chain-transactions";
import { controllerRequestsRepository } from "./controller-requests";
import { escrowOrdersRepository } from "./escrow-orders";
import { exceptionsRepository } from "./exceptions";
import { financialEntriesRepository } from "./financial-entries";
import { idempotencyKeysRepository } from "./idempotency-keys";
import { indexerCursorsRepository } from "./indexer-cursors";
import { missionsRepository } from "./missions";
import { organizationsRepository } from "./organizations";
import { purchaseGroupsRepository } from "./purchase-groups";
import { allocationsRepository, purchasesRepository } from "./purchases";
import { reconciliationRunsRepository } from "./reconciliation-runs";
import { reservationsRepository } from "./reservations";
import { resourceRequestsRepository, resourcesRepository } from "./resources";
import { samplesRepository } from "./samples";
import { sellerHistoryRepository } from "./seller-history";

export * from "./activity-events";
export * from "./agents";
export * from "./chain-transactions";
export * from "./controller-requests";
export * from "./escrow-orders";
export * from "./exceptions";
export * from "./financial-entries";
export * from "./idempotency-keys";
export * from "./indexer-cursors";
export * from "./missions";
export * from "./organizations";
export * from "./purchase-groups";
export * from "./purchases";
export * from "./reconciliation-runs";
export * from "./reservations";
export * from "./resources";
export * from "./samples";
export * from "./seller-history";

/** One typed repository per table, all bound to the same connection or transaction. */
export function createRepositories(db: Executor) {
  return {
    organizations: organizationsRepository(db),
    agents: agentsRepository(db),
    missions: missionsRepository(db),
    resources: resourcesRepository(db),
    resourceRequests: resourceRequestsRepository(db),
    purchaseGroups: purchaseGroupsRepository(db),
    purchases: purchasesRepository(db),
    allocations: allocationsRepository(db),
    chainTransactions: chainTransactionsRepository(db),
    escrowOrders: escrowOrdersRepository(db),
    financialEntries: financialEntriesRepository(db),
    activityEvents: activityEventsRepository(db),
    reservations: reservationsRepository(db),
    samples: samplesRepository(db),
    sellerHistory: sellerHistoryRepository(db),
    exceptions: exceptionsRepository(db),
    controllerRequests: controllerRequestsRepository(db),
    idempotencyKeys: idempotencyKeysRepository(db),
    indexerCursors: indexerCursorsRepository(db),
    reconciliationRuns: reconciliationRunsRepository(db),
  };
}
export type Repositories = ReturnType<typeof createRepositories>;
