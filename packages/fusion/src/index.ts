export const PACKAGE_NAME = "@overflow/fusion" as const;

// Fusion (docs/SPEC.md "Fusion: one purchase for many agents"): merges
// agents' requests into one purchase only when a real listing satisfies every
// request and its license allows shared use. Stage 1 proposes candidates by
// keyword overlap; stage 2's deterministic rules decide. The lowest common
// ancestor of the agents pays; allocations are exact integer subledger lines.
// Nothing here can sign or pay.

export * from "./types";
export * from "./candidates";
export * from "./rules";
export * from "./payer";
export * from "./allocate";
export * from "./fuse";
