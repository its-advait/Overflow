export const PACKAGE_NAME = "@overflow/payment-client" as const;

/**
 * x402 payment client pieces shared by the service, the scripts and the agents: EIP-3009 typed data, treasury
 * delegation typed data and the USDC domain check. Rule: this package only builds and signs authorizations. It
 * never moves USDC; only OverflowTreasury.settle()/reserve() and OverflowEscrow do.
 */
export * from "./typed-data";
export * from "./adapters";
