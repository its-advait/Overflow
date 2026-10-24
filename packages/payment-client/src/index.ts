export const PACKAGE_NAME = "@overflow/payment-client" as const;

/**
 * Scaffold placeholder. The x402 payment client (viem-based) lands in a later prompt.
 * Rule: this package only builds and signs authorizations. It never moves USDC;
 * only OverflowTreasury.settle()/reserve() and OverflowEscrow do.
 */
export const PAYMENT_CLIENT_STATUS = "scaffold: not implemented" as const;
