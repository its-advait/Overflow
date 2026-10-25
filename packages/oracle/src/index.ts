export const PACKAGE_NAME = "@overflow/oracle" as const;

// Oracle (docs/SPEC.md "Oracle: decide what is worth buying"): the model
// proposes requirements; code filters, ranks and explains. Nothing here can
// sign or pay, and a recommendation never authorizes a payment.

export * from "./types";
export * from "./hash";
export * from "./extract";
export * from "./coverage";
export * from "./terms";
export * from "./owned";
export * from "./rank";
export * from "./explain";
export * from "./recommend";
