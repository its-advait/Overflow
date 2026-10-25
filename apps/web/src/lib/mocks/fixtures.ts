import {
  ActivityEventSchema,
  AgentRecordSchema,
  BASE_SEPOLIA_DEPLOYMENT,
  ChainTransactionSchema,
  ControllerRequestSchema,
  EscrowOrderSchema,
  ExceptionRecordSchema,
  FinancialEntrySchema,
  MissionRecordSchema,
  PurchaseGroupSchema,
  PurchaseRecordSchema,
  ReconciliationRunSchema,
  ResourceRecordSchema,
  ResourceRequestRecordSchema,
  USDC,
  type ActivityEvent,
  type Address,
  type AgentRecord,
  type ChainTransaction,
  type ControllerRequest,
  type EscrowOrder,
  type ExceptionRecord,
  type FinancialEntry,
  type Hex,
  type MissionRecord,
  type PurchaseGroup,
  type PurchaseRecord,
  type ReconciliationRun,
  type ResourceRecord,
  type ResourceRequestRecord,
} from "@overflow/schemas";
import { z } from "zod";
import {
  FusionOutcomeSchema,
  OracleDecisionSchema,
  ServiceStatusSchema,
  type FusionOutcome,
  type OracleDecision,
  type ServiceStatus,
} from "../api/contracts";

// ---------------------------------------------------------------------------
// MOCK fixtures for apps/web. Every record is parsed through its schema at
// module load, so a fixture that drifts from @overflow/schemas fails fast.
// Nothing here came from the chain or the service. The only real constants are
// the USDC token and the Base Sepolia treasury address from the deployment
// file; every other address, hash and id is an obviously padded placeholder.
// The company, sellers and datasets are SIMULATED, as in the demo catalog.
// ---------------------------------------------------------------------------

export const MOCK_LABEL = "MOCK" as const;

/** Padded, obviously fake 20-byte address from a short hex tag. */
const addr = (tag: string): Address => `0x${tag.toLowerCase().padEnd(40, "0")}` as Address;
/** Padded, obviously fake 32-byte hash from a short hex tag. */
const b32 = (tag: string): Hex => `0x${tag.toLowerCase().padEnd(64, "0")}` as Hex;
const parseAll = <S extends z.ZodType>(schema: S, rows: z.input<S>[]): z.output<S>[] => rows.map((r) => schema.parse(r));

export const ORGANIZATION_ID = "org-acme-sim";
export const TREASURY_ADDRESS: Address = BASE_SEPOLIA_DEPLOYMENT.treasury as Address;
export const USDC_ADDRESS: Address = USDC.address as Address;

const T0 = "2026-10-24T17:00:00.000Z";
const T1 = "2026-10-24T17:05:00.000Z";
const T2 = "2026-10-24T17:12:00.000Z";
const T3 = "2026-10-24T17:20:00.000Z";
const T4 = "2026-10-24T17:41:00.000Z";
const T5 = "2026-10-24T18:02:00.000Z";
const EXPIRES = "2026-10-24T19:00:00.000Z";

// Agents -------------------------------------------------------------------

export const agents: AgentRecord[] = parseAll(AgentRecordSchema, [
  {
    id: "agent-orchestrator",
    organizationId: ORGANIZATION_ID,
    name: "Orchestrator",
    department: "operations",
    role: "orchestrator",
    nodeId: 1,
    key: addr("a9e0001"),
    createdAt: T0,
  },
  {
    id: "agent-finance",
    organizationId: ORGANIZATION_ID,
    name: "Finance analyst",
    department: "finance",
    role: "analyst",
    nodeId: 2,
    key: addr("a9e0002"),
    parentAgentId: "agent-orchestrator",
    createdAt: T0,
  },
  {
    id: "agent-research",
    organizationId: ORGANIZATION_ID,
    name: "Research analyst",
    department: "research",
    role: "analyst",
    nodeId: 3,
    key: addr("a9e0003"),
    parentAgentId: "agent-orchestrator",
    createdAt: T0,
  },
]);

// Mission ------------------------------------------------------------------

export const mission: MissionRecord = MissionRecordSchema.parse({
  id: "mission-demo-1",
  organizationId: ORGANIZATION_ID,
  goal: "Price Q3 grocery inflation inputs for the FY26 board deck: national index plus two state cuts.",
  budgetAtomic: "250000000",
  rootNodeId: 1,
  ownerAgentId: "agent-orchestrator",
  status: "active",
  createdAt: T0,
});

export const requests: ResourceRequestRecord[] = parseAll(ResourceRequestRecordSchema, [
  {
    id: "req-finance-cpi",
    missionId: mission.id,
    agentId: "agent-finance",
    status: "matched",
    topic: "grocery price index",
    regions: ["US"],
    dateRange: { start: "2025-01-01", end: "2025-09-30" },
    granularity: "monthly",
    requiredFields: ["sku", "region", "price"],
    format: ["csv", "parquet"],
    license: "company-use",
    freshness: { maxAgeDays: 45 },
    maxPriceAtomic: "9000000",
    createdAt: T1,
  },
  {
    id: "req-research-cpi",
    missionId: mission.id,
    agentId: "agent-research",
    status: "matched",
    topic: "grocery price index California",
    regions: ["US-CA"],
    dateRange: { start: "2025-03-01", end: "2025-09-30" },
    granularity: "monthly",
    requiredFields: ["sku", "price"],
    format: ["csv"],
    license: "company-use",
    freshness: { maxAgeDays: 60 },
    maxPriceAtomic: "8000000",
    createdAt: T1,
  },
]);

// Listings (SIMULATED sellers and datasets) ---------------------------------

const SELLERS = {
  northstar: { id: "sim-seller-northstar", address: addr("5e11e001") },
  pacific: { id: "sim-seller-pacific", address: addr("5e11e002") },
  cascade: { id: "sim-seller-cascade", address: addr("5e11e003") },
  freightwise: { id: "sim-seller-freightwise", address: addr("5e11e004") },
  skyfield: { id: "sim-seller-skyfield", address: addr("5e11e005") },
} as const;

export const resources: ResourceRecord[] = parseAll(ResourceRecordSchema, [
  {
    id: "res-cpi-national",
    title: "US grocery price index, monthly, national",
    sellerId: SELLERS.northstar.id,
    productId: "gpi-national-monthly",
    coverage: {
      regions: ["US", "US-CA", "US-OR", "US-WA"],
      dateRange: { start: "2024-01-01", end: "2025-09-30" },
      granularity: "monthly",
      fields: ["sku", "region", "price", "unit", "store_count"],
      format: "csv",
      asOf: "2025-10-01",
    },
    license: "company-use",
    priceAtomic: "12000000",
    manifestHash: b32("ab1e5c0d01"),
    seats: 5,
    simulated: true,
    createdAt: T0,
  },
  {
    id: "res-cpi-california",
    title: "California grocery basket, weekly",
    sellerId: SELLERS.pacific.id,
    productId: "ca-basket-weekly",
    coverage: {
      regions: ["US-CA"],
      dateRange: { start: "2025-01-06", end: "2025-09-29" },
      granularity: "weekly",
      fields: ["sku", "price", "store"],
      format: "csv",
      asOf: "2025-10-03",
    },
    license: "single-user",
    priceAtomic: "9000000",
    manifestHash: b32("ab1e5c0d02"),
    seats: 1,
    simulated: true,
    createdAt: T0,
  },
  {
    id: "res-cpi-oregon",
    title: "Oregon grocery price index, monthly",
    sellerId: SELLERS.cascade.id,
    productId: "or-gpi-monthly",
    coverage: {
      regions: ["US-OR"],
      dateRange: { start: "2024-06-01", end: "2025-09-30" },
      granularity: "monthly",
      fields: ["sku", "region", "price"],
      format: "parquet",
      asOf: "2025-10-02",
    },
    license: "company-use",
    priceAtomic: "8000000",
    manifestHash: b32("ab1e5c0d03"),
    seats: 3,
    simulated: true,
    createdAt: T0,
  },
  {
    id: "res-freight-index",
    title: "Refrigerated freight rate index, weekly",
    sellerId: SELLERS.freightwise.id,
    productId: "reefer-rates-weekly",
    coverage: {
      regions: ["US"],
      dateRange: { start: "2025-01-01", end: "2025-09-30" },
      granularity: "weekly",
      fields: ["lane", "rate_per_mile", "fuel_surcharge"],
      format: "json",
      asOf: "2025-10-04",
    },
    license: "unclear",
    priceAtomic: "15000000",
    manifestHash: b32("ab1e5c0d04"),
    seats: 1,
    simulated: true,
    createdAt: T0,
  },
  {
    id: "res-weather-daily",
    title: "Growing-region weather, daily",
    sellerId: SELLERS.skyfield.id,
    productId: "agri-weather-daily",
    coverage: {
      regions: ["US-CA", "US-OR", "US-WA"],
      dateRange: { start: "2025-01-01", end: "2025-09-30" },
      granularity: "daily",
      fields: ["station", "tmax", "tmin", "precip"],
      format: "parquet",
      asOf: "2025-10-05",
    },
    license: "company-use",
    priceAtomic: "4500000",
    manifestHash: b32("ab1e5c0d05"),
    seats: 10,
    simulated: true,
    createdAt: T0,
  },
]);

const listing = (id: string): ResourceRecord => {
  const r = resources.find((x) => x.id === id);
  if (!r) throw new Error(`fixture listing ${id} missing`);
  return r;
};

// Purchases ----------------------------------------------------------------

export const purchaseGroup: PurchaseGroup = PurchaseGroupSchema.parse({
  id: "pg-1",
  missionId: mission.id,
  resourceId: "res-cpi-national",
  payingNodeId: 1,
  requestIds: ["req-finance-cpi", "req-research-cpi"],
  mergeReason:
    "Merge: all 9 rules pass; price 12.00 USDC vs 17.00 USDC separately; company-use license with 5 seats for 2 agents.",
  createdAt: T2,
});

const TX = {
  fundMerged: b32("7a0001"),
  payoutMerged: b32("7a0002"),
  fundWeather: b32("7a0003"),
  fundOregon: b32("7a0004"),
  revealOregon: b32("7a0005"),
  fundFreight: b32("7a0006"),
  refundFreight: b32("7a0007"),
  ownerFunding: b32("7a0000"),
} as const;

const ESCROWS = {
  merged: addr("e5c0001"),
  weather: addr("e5c0002"),
  oregon: addr("e5c0003"),
  california: addr("e5c0004"),
  freight: addr("e5c0005"),
  rejected: addr("e5c0006"),
} as const;

function purchase(
  p: Partial<z.input<typeof PurchaseRecordSchema>> &
    Pick<z.input<typeof PurchaseRecordSchema>, "id" | "resourceId" | "escrowAddress" | "status" | "participatingAgentIds" | "allocations">,
): z.input<typeof PurchaseRecordSchema> {
  const res = listing(p.resourceId);
  const seller = Object.values(SELLERS).find((s) => s.id === res.sellerId);
  if (!seller) throw new Error(`fixture seller ${res.sellerId} missing`);
  return {
    orderIdBytes32: b32(`0d${p.id.replace(/[^0-9a-f]/gi, "").slice(0, 10)}`),
    missionId: mission.id,
    buyerTreasury: TREASURY_ADDRESS,
    sellerAddress: seller.address,
    chainId: 84532,
    tokenAddress: USDC_ADDRESS,
    amountAtomic: res.priceAtomic,
    payingNodeId: 1,
    resourceManifestHash: res.manifestHash,
    termsHash: b32(`7e${p.id.replace(/[^0-9a-f]/gi, "").slice(0, 10)}`),
    paymentPath: "overflow-facilitator",
    txHashes: [],
    createdAt: T2,
    updatedAt: T2,
    authorizationExpiresAt: EXPIRES,
    idempotencyKey: `propose:${mission.id}:${p.resourceId}:mock`,
    ...p,
  };
}

export const purchases: PurchaseRecord[] = parseAll(PurchaseRecordSchema, [
  // The merged purchase: two agents, one order, allocations sum to the price.
  purchase({
    id: "pur-merged-national",
    resourceId: "res-cpi-national",
    escrowAddress: ESCROWS.merged,
    status: "SETTLED",
    participatingAgentIds: ["agent-finance", "agent-research"],
    allocations: [
      { agentId: "agent-finance", department: "finance", amountAtomic: "8181818" },
      { agentId: "agent-research", department: "research", amountAtomic: "3818182" },
    ],
    purchaseGroupId: purchaseGroup.id,
    oracleReason: "Covers both requests' regions and fields at monthly granularity; cheapest listing that passes every term.",
    authorizationDigest: b32("d16e570001"),
    txHashes: [TX.fundMerged, TX.payoutMerged],
    updatedAt: T5,
  }),
  purchase({
    id: "pur-weather-daily",
    resourceId: "res-weather-daily",
    escrowAddress: ESCROWS.weather,
    status: "ESCROW_FUNDED",
    participatingAgentIds: ["agent-research"],
    allocations: [{ agentId: "agent-research", department: "research", amountAtomic: "4500000" }],
    authorizationDigest: b32("d16e570002"),
    txHashes: [TX.fundWeather],
    updatedAt: T3,
  }),
  purchase({
    id: "pur-oregon-monthly",
    resourceId: "res-cpi-oregon",
    escrowAddress: ESCROWS.oregon,
    status: "DELIVERY_PENDING",
    participatingAgentIds: ["agent-finance"],
    allocations: [{ agentId: "agent-finance", department: "finance", amountAtomic: "8000000" }],
    authorizationDigest: b32("d16e570003"),
    txHashes: [TX.fundOregon, TX.revealOregon],
    updatedAt: T4,
  }),
  purchase({
    id: "pur-california-weekly",
    resourceId: "res-cpi-california",
    escrowAddress: ESCROWS.california,
    status: "PAYMENT_PENDING",
    participatingAgentIds: ["agent-research"],
    allocations: [{ agentId: "agent-research", department: "research", amountAtomic: "9000000" }],
    authorizationDigest: b32("d16e570004"),
    updatedAt: T4,
  }),
  purchase({
    id: "pur-freight-weekly",
    resourceId: "res-freight-index",
    escrowAddress: ESCROWS.freight,
    status: "REFUNDED",
    participatingAgentIds: ["agent-finance"],
    allocations: [{ agentId: "agent-finance", department: "finance", amountAtomic: "15000000" }],
    authorizationDigest: b32("d16e570005"),
    txHashes: [TX.fundFreight, TX.refundFreight],
    updatedAt: T5,
  }),
  purchase({
    id: "pur-freight-retry",
    resourceId: "res-freight-index",
    escrowAddress: ESCROWS.rejected,
    status: "REJECTED",
    participatingAgentIds: ["agent-research"],
    allocations: [{ agentId: "agent-research", department: "research", amountAtomic: "15000000" }],
    idempotencyKey: `propose:${mission.id}:res-freight-index:retry`,
    authorizationDigest: b32("d16e570006"),
    updatedAt: T5,
  }),
]);

export const purchaseById = (id: string): PurchaseRecord | undefined => purchases.find((p) => p.id === id);

// Escrows: one in each contract state ---------------------------------------

function escrow(
  e: Pick<z.input<typeof EscrowOrderSchema>, "id" | "purchaseId" | "status"> & Partial<z.input<typeof EscrowOrderSchema>>,
): z.input<typeof EscrowOrderSchema> {
  const p = purchaseById(e.purchaseId);
  if (!p) throw new Error(`fixture purchase ${e.purchaseId} missing`);
  const tag = e.id.replace(/[^0-9a-f]/gi, "").slice(0, 8);
  return {
    orderIdBytes32: p.orderIdBytes32,
    escrowAddress: p.escrowAddress,
    sellerAddress: p.sellerAddress,
    amountAtomic: p.amountAtomic,
    bondAtomic: "1000000",
    termsHash: p.termsHash,
    manifestHash: p.resourceManifestHash,
    rootPlain: b32(`a1${tag}`),
    rootCipher: b32(`c1${tag}`),
    keyCommitment: b32(`cc${tag}`),
    revealDeadline: "1792436400",
    challengeWindow: "3600",
    sourceKey: p.sellerAddress,
    minTimestamp: "1792000000",
    createdAt: T2,
    updatedAt: T2,
    ...e,
  };
}

export const escrows: EscrowOrder[] = parseAll(EscrowOrderSchema, [
  escrow({ id: "esc-california", purchaseId: "pur-california-weekly", status: "Created" }),
  escrow({ id: "esc-weather", purchaseId: "pur-weather-daily", status: "Funded", updatedAt: T3 }),
  escrow({ id: "esc-oregon", purchaseId: "pur-oregon-monthly", status: "Revealed", revealedKey: b32("4e1ea1ed03"), updatedAt: T4 }),
  escrow({ id: "esc-national", purchaseId: "pur-merged-national", status: "Settled", revealedKey: b32("4e1ea1ed01"), updatedAt: T5 }),
  escrow({
    id: "esc-freight",
    purchaseId: "pur-freight-weekly",
    status: "Refunded",
    refundReason: "reveal deadline passed without a key (SIMULATED ghost seller)",
    updatedAt: T5,
  }),
]);

export const escrowByPurchase = (purchaseId: string): EscrowOrder | undefined => escrows.find((e) => e.purchaseId === purchaseId);
export const escrowByAddress = (address: string): EscrowOrder | undefined =>
  escrows.find((e) => e.escrowAddress.toLowerCase() === address.toLowerCase());

// Chain transactions (decoded logs) ----------------------------------------

function tx(
  t: Pick<z.input<typeof ChainTransactionSchema>, "id" | "purchaseId" | "txHash" | "eventName" | "blockNumber" | "observedAt"> &
    Partial<z.input<typeof ChainTransactionSchema>>,
): z.input<typeof ChainTransactionSchema> {
  const p = t.purchaseId ? purchaseById(t.purchaseId) : undefined;
  return {
    logIndex: 0,
    contractAddress: p?.escrowAddress ?? TREASURY_ADDRESS,
    args: p ? { orderId: p.orderIdBytes32, amount: p.amountAtomic } : {},
    confirmed: true,
    ...t,
  };
}

export const chainTransactions: ChainTransaction[] = parseAll(ChainTransactionSchema, [
  tx({
    id: "ctx-owner-funding",
    txHash: TX.ownerFunding,
    eventName: "Transfer",
    blockNumber: "49850001",
    observedAt: T0,
    contractAddress: USDC_ADDRESS,
    args: { from: BASE_SEPOLIA_DEPLOYMENT.owner, to: TREASURY_ADDRESS, value: "250000000" },
  }),
  tx({ id: "ctx-merged-funded", purchaseId: "pur-merged-national", txHash: TX.fundMerged, eventName: "OrderFunded", blockNumber: "49850120", observedAt: T3 }),
  tx({ id: "ctx-merged-paidout", purchaseId: "pur-merged-national", txHash: TX.payoutMerged, eventName: "PaidOut", blockNumber: "49850410", observedAt: T5 }),
  tx({ id: "ctx-weather-funded", purchaseId: "pur-weather-daily", txHash: TX.fundWeather, eventName: "OrderFunded", blockNumber: "49850131", observedAt: T3 }),
  tx({ id: "ctx-oregon-funded", purchaseId: "pur-oregon-monthly", txHash: TX.fundOregon, eventName: "OrderFunded", blockNumber: "49850140", observedAt: T3 }),
  tx({ id: "ctx-oregon-revealed", purchaseId: "pur-oregon-monthly", txHash: TX.revealOregon, eventName: "Revealed", blockNumber: "49850300", observedAt: T4 }),
  tx({ id: "ctx-freight-funded", purchaseId: "pur-freight-weekly", txHash: TX.fundFreight, eventName: "OrderFunded", blockNumber: "49850150", observedAt: T3 }),
  tx({ id: "ctx-freight-refunded", purchaseId: "pur-freight-weekly", txHash: TX.refundFreight, eventName: "Refunded", blockNumber: "49850420", observedAt: T5 }),
]);

// Ledger: double-entry rows that book the chain events above -----------------

const key = (hash: Hex, logIndex = 0) => `${hash}:${logIndex}`;

export const ledgerEntries: FinancialEntry[] = parseAll(FinancialEntrySchema, [
  {
    id: "fe-owner-funding",
    debitAccount: "usdc-treasury",
    creditAccount: "owner-contribution",
    amountAtomic: "250000000",
    memo: "Owner funded the treasury (USDC Transfer)",
    eventKey: key(TX.ownerFunding),
    sourceEventId: key(TX.ownerFunding),
    txHash: TX.ownerFunding,
    postedAt: T0,
  },
  {
    id: "fe-merged-funded",
    purchaseId: "pur-merged-national",
    debitAccount: "escrow-deposit",
    creditAccount: "usdc-treasury",
    amountAtomic: "12000000",
    memo: "Escrow funded: US grocery price index (merged, 2 agents)",
    eventKey: key(TX.fundMerged),
    sourceEventId: key(TX.fundMerged),
    txHash: TX.fundMerged,
    postedAt: T3,
  },
  {
    id: "fe-merged-expense-finance",
    purchaseId: "pur-merged-national",
    debitAccount: "data-expense",
    creditAccount: "escrow-deposit",
    amountAtomic: "8181818",
    memo: "Settled: finance share of the merged purchase",
    eventKey: key(TX.payoutMerged),
    sourceEventId: `${key(TX.payoutMerged)}#finance`,
    department: "finance",
    txHash: TX.payoutMerged,
    postedAt: T5,
  },
  {
    id: "fe-merged-expense-research",
    purchaseId: "pur-merged-national",
    debitAccount: "data-expense",
    creditAccount: "escrow-deposit",
    amountAtomic: "3818182",
    memo: "Settled: research share of the merged purchase",
    eventKey: key(TX.payoutMerged),
    sourceEventId: `${key(TX.payoutMerged)}#research`,
    department: "research",
    txHash: TX.payoutMerged,
    postedAt: T5,
  },
  {
    id: "fe-weather-funded",
    purchaseId: "pur-weather-daily",
    debitAccount: "escrow-deposit",
    creditAccount: "usdc-treasury",
    amountAtomic: "4500000",
    memo: "Escrow funded: growing-region weather",
    eventKey: key(TX.fundWeather),
    sourceEventId: key(TX.fundWeather),
    txHash: TX.fundWeather,
    postedAt: T3,
  },
  {
    id: "fe-oregon-funded",
    purchaseId: "pur-oregon-monthly",
    debitAccount: "escrow-deposit",
    creditAccount: "usdc-treasury",
    amountAtomic: "8000000",
    memo: "Escrow funded: Oregon grocery price index",
    eventKey: key(TX.fundOregon),
    sourceEventId: key(TX.fundOregon),
    txHash: TX.fundOregon,
    postedAt: T3,
  },
  {
    id: "fe-freight-funded",
    purchaseId: "pur-freight-weekly",
    debitAccount: "escrow-deposit",
    creditAccount: "usdc-treasury",
    amountAtomic: "15000000",
    memo: "Escrow funded: refrigerated freight index",
    eventKey: key(TX.fundFreight),
    sourceEventId: key(TX.fundFreight),
    txHash: TX.fundFreight,
    postedAt: T3,
  },
  {
    id: "fe-freight-refunded",
    purchaseId: "pur-freight-weekly",
    debitAccount: "usdc-treasury",
    creditAccount: "escrow-deposit",
    amountAtomic: "15000000",
    memo: "Refunded: seller never revealed; USDC back in the treasury",
    eventKey: key(TX.refundFreight),
    sourceEventId: key(TX.refundFreight),
    txHash: TX.refundFreight,
    postedAt: T5,
  },
]);

// Activity -------------------------------------------------------------------

export const activity: ActivityEvent[] = parseAll(ActivityEventSchema, [
  { id: "ev-01", at: T0, kind: "mission.created", message: `Mission created: ${mission.goal}`, missionId: mission.id, agentId: "agent-orchestrator" },
  { id: "ev-02", at: T1, kind: "agent.tool_call", message: "finance → propose_purchase(grocery price index, US, monthly)", missionId: mission.id, agentId: "agent-finance" },
  { id: "ev-03", at: T1, kind: "agent.tool_call", message: "research → propose_purchase(grocery price index, California, monthly)", missionId: mission.id, agentId: "agent-research" },
  {
    id: "ev-04",
    at: T2,
    kind: "oracle.recommendation",
    message: "Oracle ranked res-cpi-national first for req-finance-cpi (2 rejected). This is a recommendation; it authorizes no payment.",
    missionId: mission.id,
    agentId: "agent-finance",
    simulated: true,
  },
  {
    id: "ev-05",
    at: T2,
    kind: "fusion.decision",
    message: "Fusion: merge req-finance-cpi + req-research-cpi on res-cpi-national; all 9 rules pass; payer node 1 (mission-root).",
    missionId: mission.id,
    purchaseId: "pur-merged-national",
    simulated: true,
  },
  { id: "ev-06", at: T2, kind: "purchase.proposed", message: "Proposed 12.00 USDC to Northstar Data (SIMULATED) for 2 agents.", missionId: mission.id, purchaseId: "pur-merged-national", simulated: true },
  { id: "ev-07", at: T3, kind: "payment.authorized", message: "Finance signed the authorization; treasury reserved 12.00 USDC on node 1.", missionId: mission.id, purchaseId: "pur-merged-national", agentId: "agent-finance" },
  { id: "ev-08", at: T3, kind: "escrow.funded", message: "OrderFunded confirmed for 12.00 USDC.", missionId: mission.id, purchaseId: "pur-merged-national", txHash: TX.fundMerged },
  { id: "ev-09", at: T3, kind: "escrow.funded", message: "OrderFunded confirmed for 4.50 USDC (weather).", missionId: mission.id, purchaseId: "pur-weather-daily", txHash: TX.fundWeather },
  { id: "ev-10", at: T4, kind: "escrow.revealed", message: "Seller revealed the key for the Oregon index; delivery pending verification.", missionId: mission.id, purchaseId: "pur-oregon-monthly", txHash: TX.revealOregon, simulated: true },
  {
    id: "ev-11",
    at: T4,
    kind: "policy.blocked",
    message: "Treasury rejected the retry of the freight index: node 3 would exceed its cap.",
    missionId: mission.id,
    purchaseId: "pur-freight-retry",
    agentId: "agent-research",
    decodedRevert: "OverBudget(3)",
  },
  { id: "ev-12", at: T4, kind: "exception.opened", message: "PAUSE_REQUEST opened for node 3 (research) after the cap revert.", missionId: mission.id, agentId: "agent-orchestrator" },
  { id: "ev-13", at: T4, kind: "controller.requested", message: "Prepared pause(3) for the owner to approve in Coinbase Wallet. Nothing is paused yet.", missionId: mission.id },
  { id: "ev-14", at: T5, kind: "escrow.settled", message: "PaidOut confirmed: 12.00 USDC to Northstar Data (SIMULATED).", missionId: mission.id, purchaseId: "pur-merged-national", txHash: TX.payoutMerged, simulated: true },
  { id: "ev-15", at: T5, kind: "escrow.refunded", message: "Refunded 15.00 USDC: freight seller missed the reveal deadline.", missionId: mission.id, purchaseId: "pur-freight-weekly", txHash: TX.refundFreight, simulated: true },
  { id: "ev-16", at: T5, kind: "seller.flagged", message: "Freightwise (SIMULATED ghost seller) flagged after a late reveal.", missionId: mission.id, simulated: true },
  { id: "ev-17", at: T5, kind: "reconciliation.ok", message: "Reconciliation at block 49850420: chain and ledger agree (225.50 USDC).", missionId: mission.id },
]);

// Exceptions and controller requests -----------------------------------------

export const controllerRequest: ControllerRequest = ControllerRequestSchema.parse({
  id: "cr-pause-3",
  action: { kind: "pause", nodeId: 3 },
  exceptionId: "exc-pause-3",
  requestedBy: "agent-orchestrator",
  reason: "Research node hit OverBudget(3) twice in one mission.",
  target: TREASURY_ADDRESS,
  // MOCK calldata shape only: selector plus one uint256 argument. Not a real encoding.
  data: `0x136439dd${"3".padStart(64, "0")}` as Hex,
  value: "0",
  summary: "pause(3): node 3 (research analyst) can no longer authorize payments until unpaused.",
  status: "pending",
  createdAt: T4,
});

export const exception: ExceptionRecord = ExceptionRecordSchema.parse({
  id: "exc-pause-3",
  type: "PAUSE_REQUEST",
  reason: "Research node hit OverBudget(3) twice in one mission.",
  status: "open",
  openedAt: T4,
  subject: "node:3",
  requestedBy: "agent-orchestrator",
  details: { nodeId: 3, agentId: "agent-research" },
});

export const reconciliationRun: ReconciliationRun = ReconciliationRunSchema.parse({
  id: "rec-1",
  ranAt: T5,
  trigger: "indexer",
  blockNumber: "49850420",
  treasuryChainAtomic: "225500000",
  treasuryLedgerAtomic: "225500000",
  treasuryDifferenceAtomic: "0",
  escrowsChecked: 5,
  eventsChecked: 8,
  differences: [],
  exceptionIds: [],
  status: "ok",
});

// Oracle and Fusion decisions for the merged purchase -------------------------

export const oracleDecisions: OracleDecision[] = parseAll(OracleDecisionSchema, [
  {
    requestId: "req-finance-cpi",
    chosen: "res-cpi-national",
    alternatives: ["res-cpi-oregon"],
    rejected: [
      { listingId: "res-cpi-california", reasons: [{ reason: "license", detail: "single-user; request needs company-use" }] },
      { listingId: "res-freight-index", reasons: [{ reason: "field", detail: "missing sku, price" }] },
      { listingId: "res-weather-daily", reasons: [{ reason: "field", detail: "missing sku, region, price" }] },
    ],
    assumptions: ["Monthly granularity is acceptable for a board deck."],
    summary: "Chose US grocery price index (national) at 12.00 USDC. This is a recommendation; it authorizes no payment.",
    simulated: true,
  },
  {
    requestId: "req-research-cpi",
    chosen: "res-cpi-national",
    alternatives: [],
    rejected: [
      { listingId: "res-cpi-california", reasons: [{ reason: "license", detail: "single-user; request needs company-use" }] },
      { listingId: "res-cpi-oregon", reasons: [{ reason: "region", detail: "US-OR does not cover US-CA" }] },
    ],
    assumptions: [],
    summary: "Chose US grocery price index (national), which covers US-CA. This is a recommendation; it authorizes no payment.",
    simulated: true,
  },
]);

export const fusionOutcomes: FusionOutcome[] = parseAll(FusionOutcomeSchema, [
  {
    listingId: "res-cpi-national",
    requestIds: ["req-finance-cpi", "req-research-cpi"],
    merge: true,
    checks: [
      { rule: "identity", passed: true, evidence: "same listing res-cpi-national" },
      { rule: "geography", passed: true, evidence: "US ⊇ US, US-CA" },
      { rule: "dates", passed: true, evidence: "2024-01-01..2025-09-30 covers both ranges" },
      { rule: "resolution", passed: true, evidence: "monthly for both" },
      { rule: "fields", passed: true, evidence: "sku, region, price present" },
      { rule: "format", passed: true, evidence: "csv readable by both" },
      { rule: "license", passed: true, evidence: "company-use, 5 seats for 2 agents" },
      { rule: "freshness", passed: true, evidence: "asOf 2025-10-01 within 45 days" },
      { rule: "price", passed: true, evidence: "12.00 USDC vs 17.00 USDC separately" },
    ],
    failingRules: [],
    reason: purchaseGroup.mergeReason,
    simulated: true,
    payer: { agentId: null, nodeId: 1, rule: "mission-root", evidence: "no agent has an onchain node yet; mission root pays" },
    waitingRequestIds: [],
  },
]);

export const serviceStatus: ServiceStatus = ServiceStatusSchema.parse({
  service: "overflow-service",
  scaffold: false,
  chainId: 84532,
  session: { organizationId: ORGANIZATION_ID, principal: "controller:mock" },
  indexer: { state: "idle", reason: `${MOCK_LABEL}: fixtures, no indexer` },
});
