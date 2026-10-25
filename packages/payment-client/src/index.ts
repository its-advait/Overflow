export const PACKAGE_NAME = "@overflow/payment-client" as const;

/**
 * x402 payment client for Overflow.
 *
 * Parses a seller's 402, checks it against our PurchaseOrder, and signs an EIP-3009 TransferWithAuthorization
 * with from = the treasury using an agent node key (x402, quote, authorization, header, fetch). typed-data adds
 * the treasury delegation typed data (CreateChild / PauseChild) and the service's boot-time token reader.
 * It never moves USDC. Only OverflowTreasury.settle()/reserve() and OverflowEscrow do, and USDC asks the
 * treasury (ERC-1271) before any transfer. Payment adapters: "@overflow/payment-client/adapters".
 */
export * from "./errors";
export * from "./x402";
export * from "./quote";
export * from "./token-domain";
export * from "./authorization";
export * from "./header";
export * from "./fetch";
export * from "./golden";
export * from "./typed-data";
