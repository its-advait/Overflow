import type { Address, Hex } from "@overflow/schemas";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveSellerSecret } from "./config.js";
import { loadRecourseCatalog, type RecourseListing } from "./datasets.js";

// Shared SIMULATED fixtures for the recourse tests (no network).
export const SMALL_LISTING_ID = "listing-national-annual-2024-2026"; // 48 chunks
export const SELLER_PK: Hex = keccak256(toBytes("overflow.test.recourse-seller-key"));
export const SELLER = privateKeyToAccount(SELLER_PK);
export const SELLER_SECRET = deriveSellerSecret(SELLER_PK);
export const BUYER = "0x1111111111111111111111111111111111111111" as Address;
export const SALT: Hex = keccak256(toBytes("overflow.test.recourse-salt"));

export async function loadSmallListing(): Promise<RecourseListing> {
  const { listings } = await loadRecourseCatalog();
  const l = listings.get(SMALL_LISTING_ID);
  if (!l) throw new Error(`fixture listing ${SMALL_LISTING_ID} missing from the catalog`);
  return l;
}
