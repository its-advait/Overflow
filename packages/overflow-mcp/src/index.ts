export const PACKAGE_NAME = "@overflow/overflow-mcp" as const;

/**
 * stdio MCP server that lets any agent pay x402 APIs under an Overflow node's policy.
 *
 * Three tools: overflow_budget (chain reads), overflow_quote (fetch the 402, simulate the payment with the
 * facilitator's /verify; nothing is broadcast) and overflow_pay (one EIP-3009 authorization with from = the
 * treasury, settled only by OverflowTreasury.settle() through the facilitator). The server never holds USDC
 * or the owner key; a valid signature is never enough, the treasury's policy decides.
 */
export * from "./config";
export * from "./chain";
export * from "./refusals";
export * from "./facilitator";
export * from "./quote";
export * from "./pay";
export * from "./tools";
export * from "./mcp";
