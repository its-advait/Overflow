export const PACKAGE_NAME = "@overflow/recourse-crypto" as const;

/**
 * Hashing helpers for recourse data. Rule: hash fixed ABI-encoded fields or raw bytes, never JSON.
 * merkle.ts mirrors contracts/src/MerkleLib.sol. Chunk keystream helpers land with tier 2.
 */
export * from "./merkle";
