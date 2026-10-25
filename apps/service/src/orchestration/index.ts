/**
 * Orchestration module: missions, Oracle, Fusion and the purchase state machine.
 * PurchaseService is the state machine; createOraclePort wires @overflow/oracle
 * into the API's OrchestrationPort; seedCatalog loads the SIMULATED catalog.
 * Fusion arrives at P6.2.
 */
export * from "./purchase-service";
export * from "./catalog";
export * from "./oracle-port";
