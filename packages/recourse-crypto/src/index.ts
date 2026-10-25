export const PACKAGE_NAME = "@overflow/recourse-crypto" as const;

/**
 * Hashing helpers for recourse data. Rule: hash fixed ABI-encoded fields or raw bytes, never JSON.
 * merkle.ts mirrors contracts/src/MerkleLib.sol; crypto.ts mirrors contracts/src/RecourseCrypto.sol.
 * Byte layout, keystream and Merkle rules: ./README.md. Golden vectors: src/*.test.ts and the forge tests.
 */
export * from "./merkle";
export * from "./crypto";
