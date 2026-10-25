/**
 * The SIMULATED direct pay-per-call PurchaseOrder builder now lives in the payment client so any
 * agent (the overflow-mcp server included) can build the same order the sellers demo pays with.
 */
export { directApiOrder, type DirectApiOrderInput } from "@overflow/payment-client";
