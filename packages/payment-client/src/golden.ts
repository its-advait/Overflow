import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, USDC } from "@overflow/schemas";
import {
  TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
  authorizationDigest,
  authorizationStructHash,
  authorizationToJson,
  buildTransferTypedData,
  type TransferAuthorization,
} from "./authorization";
import { USDC_DOMAIN } from "./token-domain";
import type { Eip3009AuthorizationJson } from "./x402";

// ---------------------------------------------------------------------------
// Golden vector shared with contracts/test/PaymentClientGolden.t.sol. Fixed inputs; both sides
// recompute the digest and compare. The key is derived from a public label: TEST ONLY, never
// fund it. Pattern from reference/leash (Golden.t.sol + packages/abi/golden/digest.json).
// ---------------------------------------------------------------------------

export const GOLDEN_VECTOR_RELATIVE_PATH = "test/golden.json";
export const GOLDEN_FIXTURE_RELATIVE_PATH = "contracts/test/fixtures/payment-client-golden.json";

export const GOLDEN_TREASURY: Address = "0x1111111111111111111111111111111111111111";
export const GOLDEN_TO: Address = "0x2222222222222222222222222222222222222222";
export const GOLDEN_VALUE = 20000n; // 0.02 USDC in atomic units
export const GOLDEN_VALID_AFTER = 1791700000n;
export const GOLDEN_VALID_BEFORE = 1791700120n;
export const GOLDEN_NONCE_LABEL = "overflow.golden.nonce";
export const GOLDEN_KEY_LABEL = "overflow.golden.key";

export const GOLDEN_AUTHORIZATION: TransferAuthorization = {
  from: GOLDEN_TREASURY,
  to: GOLDEN_TO,
  value: GOLDEN_VALUE,
  validAfter: GOLDEN_VALID_AFTER,
  validBefore: GOLDEN_VALID_BEFORE,
  nonce: keccak256(stringToBytes(GOLDEN_NONCE_LABEL)),
};

/** TEST ONLY: uint256(keccak256("overflow.golden.key")), the same derivation Foundry uses. */
export const GOLDEN_TEST_ONLY_PRIVATE_KEY: Hex = keccak256(stringToBytes(GOLDEN_KEY_LABEL));

export interface GoldenVector {
  note: string;
  chainId: number;
  usdc: Address;
  domainSeparator: Hex;
  typehash: Hex;
  testOnlyPrivateKey: Hex;
  signer: Address;
  authorization: Eip3009AuthorizationJson;
  structHash: Hex;
  digest: Hex;
  signature: Hex;
}

export async function generateGoldenVector(): Promise<GoldenVector> {
  const account = privateKeyToAccount(GOLDEN_TEST_ONLY_PRIVATE_KEY);
  const typedData = buildTransferTypedData(USDC_DOMAIN, GOLDEN_AUTHORIZATION);
  const signature = await account.signTypedData(typedData);
  return {
    note:
      "SIMULATED golden vector from packages/payment-client/src/golden.ts. testOnlyPrivateKey = keccak256(\"overflow.golden.key\"): public, never fund it. Amounts are atomic units (6 decimals). from = the treasury, signed by a node key.",
    chainId: CHAIN_ID,
    usdc: USDC.address,
    domainSeparator: USDC.domainSeparator,
    typehash: TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
    testOnlyPrivateKey: GOLDEN_TEST_ONLY_PRIVATE_KEY,
    signer: account.address,
    authorization: authorizationToJson(GOLDEN_AUTHORIZATION),
    structHash: authorizationStructHash(GOLDEN_AUTHORIZATION),
    digest: authorizationDigest(USDC_DOMAIN, GOLDEN_AUTHORIZATION),
    signature,
  };
}

export function serializeGoldenVector(v: GoldenVector): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}
