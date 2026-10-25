import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import { USDC } from "@overflow/schemas";
import { escrowAbi, escrowFactoryAbi, treasuryAbi, usdcAbi } from "../abi.js";
import type { RawLog } from "../client.js";

// ---------------------------------------------------------------------------
// SIMULATED recorded log fixture. No Overflow contract is deployed yet, so the
// logs are encoded from the provisional ABI with viem (deterministic). The
// addresses are the service test constants; nothing here is a real deployment.
// Run: pnpm --filter @overflow/service exec tsx src/chain/fixtures/build-fixture.ts
// ---------------------------------------------------------------------------

export const FIXTURE = {
  deployBlock: "100",
  head: "115",
  treasury: "0x1111111111111111111111111111111111111111" as Address,
  seller: "0x2222222222222222222222222222222222222222" as Address,
  escrow1: "0x3333333333333333333333333333333333333333" as Address,
  factory: "0x5555555555555555555555555555555555555555" as Address,
  escrow2: "0x6666666666666666666666666666666666666666" as Address,
  escrow3: "0x7777777777777777777777777777777777777777" as Address,
  owner: "0x9999999999999999999999999999999999999999" as Address,
  /** SIMULATED third-party x402 API paid directly (no escrow). */
  apiSeller: "0x8888888888888888888888888888888888888888" as Address,
  /** The real Base Sepolia USDC address; its Transfer logs here are encoded, not recorded. */
  usdc: USDC.address as Address,
  orchestratorKey: "0x0000000000000000000000000000000000000a01" as Address, // seeded orchestrator placeholder key (lowercase for viem)
  amount: "12000000",
  /** Order 2's seller bond (20% of the price), forfeited on the missed reveal. */
  bond: "2400000",
  /** The controller's funding transfer. */
  funding: "50000000",
  /** The direct x402 API purchase (p4). */
  apiAmount: "3000000",
  blockTimestamp: "1700000000",
} as const;

const b32 = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const txh = (n: number): Hex => `0x${"f".repeat(60)}${n.toString(16).padStart(4, "0")}` as Hex;

function encodeLog(
  abi: Abi,
  address: Address,
  eventName: string,
  args: Record<string, unknown>,
  block: number,
  logIndex: number,
  txNo: number,
): RawLog {
  const event = abi.find((i) => i.type === "event" && i.name === eventName) as AbiEvent | undefined;
  if (!event) throw new Error(`no event ${eventName}`);
  const topics = encodeEventTopics({ abi: [event], eventName, args } as never) as Hex[];
  const nonIndexed = event.inputs.filter((i) => !i.indexed);
  const data = nonIndexed.length === 0 ? ("0x" as Hex) : encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]));
  return { address, topics, data, blockNumber: String(block), blockTimestamp: FIXTURE.blockTimestamp, transactionHash: txh(txNo), logIndex };
}

export function buildFixtureLogs(): RawLog[] {
  const F = FIXTURE;
  const T = (name: string, args: Record<string, unknown>, block: number, idx: number, tx: number) =>
    encodeLog(treasuryAbi, F.treasury, name, args, block, idx, tx);
  const FA = (name: string, args: Record<string, unknown>, block: number, idx: number, tx: number) =>
    encodeLog(escrowFactoryAbi, F.factory, name, args, block, idx, tx);
  const E = (escrow: Address, name: string, args: Record<string, unknown>, block: number, idx: number, tx: number) =>
    encodeLog(escrowAbi, escrow, name, args, block, idx, tx);
  const X = (from: Address, to: Address, value: bigint, block: number, idx: number, tx: number) =>
    encodeLog(usdcAbi, F.usdc, "Transfer", { from, to, value }, block, idx, tx);
  const amount = BigInt(F.amount);
  const bond = BigInt(F.bond);
  return [
    // The controller funds the treasury: the only event is USDC's Transfer.
    X(F.owner, F.treasury, BigInt(F.funding), 100, 0, 20),
    T("NodeCreated", { id: 1n, parent: 0n, key: F.orchestratorKey, cap: 50_000_000n, maxPerCall: 20_000_000n, expiry: 1_900_000_000n }, 101, 0, 1),
    T("AllowSet", { payee: F.seller, allowed: true }, 102, 0, 2),
    T("EscrowFactorySet", { factory: F.factory }, 102, 1, 2),
    FA("OrderCreated", { orderId: b32(1), escrow: F.escrow1, seller: F.seller, buyer: F.treasury, amount, bond: 0n, termsHash: b32(9) }, 103, 0, 3),
    // Overflow-facilitator path: settle() -> USDC Transfer, then Paid, then the escrow's OrderFunded, one transaction.
    X(F.treasury, F.escrow1, amount, 104, 0, 4),
    T("Paid", { id: 1n, to: F.escrow1, value: amount, nonce: b32(0xaa) }, 104, 1, 4),
    E(F.escrow1, "OrderFunded", { orderId: b32(1), amount }, 104, 2, 4),
    E(F.escrow1, "KeyRevealed", { orderId: b32(1), key: b32(0x77) }, 105, 0, 5),
    E(F.escrow1, "Accepted", { orderId: b32(1), signer: F.orchestratorKey }, 106, 0, 6),
    E(F.escrow1, "PaidOut", { orderId: b32(1), seller: F.seller, amount, bond: 0n }, 106, 1, 6),
    FA("OrderCreated", { orderId: b32(2), escrow: F.escrow2, seller: F.seller, buyer: F.treasury, amount, bond, termsHash: b32(9) }, 107, 0, 7),
    T("Reserved", { digest: b32(0xd2), id: 1n, to: F.escrow2, value: amount, validBefore: 1_700_000_600n, nonce: b32(0xbb) }, 107, 1, 7),
    // Coinbase-facilitator path: the facilitator calls USDC directly, so there is no Paid; only Transfer + OrderFunded.
    X(F.treasury, F.escrow2, amount, 108, 0, 8),
    E(F.escrow2, "OrderFunded", { orderId: b32(2), amount }, 108, 1, 8),
    // Missed reveal: the price comes back to the treasury and the seller's bond is forfeited to it.
    X(F.escrow2, F.treasury, amount, 109, 0, 9),
    E(F.escrow2, "Refunded", { orderId: b32(2), amount, reason: "timeout: no reveal before deadline" }, 109, 1, 9),
    X(F.escrow2, F.treasury, bond, 109, 2, 9),
    E(F.escrow2, "BondForfeited", { orderId: b32(2), seller: F.seller, bond }, 109, 3, 9),
    E(F.escrow2, "CheatProven", { seller: F.seller, index: 3n }, 110, 0, 10),
    T("NodePaused", { id: 1n, by: F.owner }, 110, 1, 11),
    T("ReservationReleased", { digest: b32(0xd2), id: 1n, value: amount, budgetRestored: false }, 110, 2, 12),
    // Order 3 never had an OrderCreated the factory emitted here; its escrow is unknown to the indexer.
    FA("OrderCreated", { orderId: b32(3), escrow: F.escrow3, seller: F.seller, buyer: F.treasury, amount, bond: 0n, termsHash: b32(9) }, 111, 0, 13),
    E(F.escrow3, "PaidOut", { orderId: b32(3), seller: F.seller, amount, bond: 0n }, 111, 1, 13),
    // Direct x402 API purchase (p4): settle() to a non-escrow payee. Expense books from the Transfer.
    X(F.treasury, F.apiSeller, BigInt(F.apiAmount), 112, 0, 15),
    T("Paid", { id: 1n, to: F.apiSeller, value: BigInt(F.apiAmount), nonce: b32(0xcc) }, 112, 1, 15),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(new URL("./base-sepolia-logs.json", import.meta.url));
  writeFileSync(out, JSON.stringify({ simulated: true, note: "encoded from the provisional ABI; not a real deployment", ...FIXTURE, logs: buildFixtureLogs() }, null, 2) + "\n");
  console.log(`wrote ${out}`);
}
