/**
 * Orchestration module: missions, Oracle, Fusion and the purchase state machine.
 * Only the state machine (PurchaseService) is implemented here; Oracle and
 * Fusion arrive through the OrchestrationPort in ../api/ports.ts.
 */
export * from "./purchase-service";
export const ORCHESTRATION_STATUS = "purchase state machine ready; Oracle/Fusion not wired" as const;
