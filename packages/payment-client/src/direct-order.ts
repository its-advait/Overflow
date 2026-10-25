import { PurchaseOrderSchema, type Address, type AtomicAmount, type PurchaseOrder } from "@overflow/schemas";
import { USDC } from "@overflow/schemas";
import { encodeAbiParameters, getAddress, keccak256, zeroAddress } from "viem";

// ---------------------------------------------------------------------------
// A SIMULATED PurchaseOrder for a direct pay-per-call API (no escrow). The agent
// states what it expects to pay and to whom; checkQuote then refuses any 402
// that disagrees. escrowAddress is the zero address so checkQuote cannot take
// the escrow branch: the payee must be an owner-allowlisted direct seller AND
// equal sellerAddress. Hashes are over fixed ABI-encoded fields, never JSON.
// ---------------------------------------------------------------------------

export interface DirectApiOrderInput {
  resourceUrl: string;
  payTo: Address;
  amountAtomic: AtomicAmount;
  treasury: Address;
  nodeId: number;
  /** Unix seconds; defaults to now. */
  nowSeconds?: number;
  missionId?: string;
}

const DIRECT_API_TAG = "overflow.simulated.direct-api";

export function directApiOrder(input: DirectApiOrderInput): PurchaseOrder {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const seller = getAddress(input.payTo);
  const treasury = getAddress(input.treasury);
  const termsHash = keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], [DIRECT_API_TAG, input.resourceUrl]));
  const manifestHash = keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], [`${DIRECT_API_TAG}.manifest`, input.resourceUrl]));
  const orderIdBytes32 = keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
      [input.resourceUrl, treasury, seller, BigInt(input.amountAtomic), termsHash, BigInt(now)],
    ),
  );
  return PurchaseOrderSchema.parse({
    id: `direct-${orderIdBytes32.slice(2, 18)}`,
    orderIdBytes32,
    missionId: input.missionId ?? "mission-direct-api-demo",
    resourceId: `direct-api:${input.resourceUrl}`,
    buyerTreasury: treasury,
    sellerAddress: seller,
    escrowAddress: zeroAddress,
    chainId: 84532,
    tokenAddress: USDC.address,
    amountAtomic: input.amountAtomic,
    payingNodeId: input.nodeId,
    participatingAgentIds: [],
    allocations: [],
    resourceManifestHash: manifestHash,
    termsHash,
    paymentPath: "overflow-facilitator",
    txHashes: [],
    createdAt: new Date(now * 1000).toISOString(),
    authorizationExpiresAt: new Date((now + 120) * 1000).toISOString(),
    status: "RESERVED",
  });
}
