import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import { USDC } from "@overflow/schemas";
import { escrowAbi, escrowFactoryAbi, treasuryAbi, usdcAbi } from "../abi.js";
import type { RawLog } from "../log-source.js";

// ---------------------------------------------------------------------------
// SIMULATED recorded log fixture. The logs are encoded with viem from the ABIs
// generated from the built contracts (deterministic), with the service test
// addresses; nothing here is a real deployment. Escrow events carry no orderId
// (the emitting address is the order), OrderFunded reports the balance (price +
// bond), Refunded carries only its reason and the whole balance comes back in
// one USDC Transfer.
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
  /** Order 4 (p5): a second SIMULATED seller whose swapped chunk is proven onchain. */
  cheater: "0xcccccccccccccccccccccccccccccccccccccccc" as Address,
  escrow4: "0xdddddddddddddddddddddddddddddddddddddddd" as Address,
  owner: "0x9999999999999999999999999999999999999999" as Address,
  /** SIMULATED third-party x402 API paid directly (no escrow). */
  apiSeller: "0x8888888888888888888888888888888888888888" as Address,
  /** The real Base Sepolia USDC address; its Transfer logs here are encoded, not recorded. */
  usdc: USDC.address as Address,
  orchestratorKey: "0x0000000000000000000000000000000000000a01" as Address, // seeded orchestrator placeholder key (lowercase for viem)
  amount: "12000000",
  /** Orders 2 and 4 carry a seller bond (20% of the price); both come back to the treasury with the price. */
  bond: "2400000",
  /** Balance the escrow reports in OrderFunded when a bond was posted. */
  fundedWithBond: "14400000",
  /** The controller's funding transfer. */
  funding: "50000000",
  /** The direct x402 API purchase (p4). */
  apiAmount: "3000000",
  /** Node 1's cap after the controller's CapRaised. */
  raisedCap: "80000000",
  blockTimestamp: "1700000000",
  /** KeyRevealed.challengeEnd for orders 1 and 4 (reveal at 1700000000 + 600 s window). */
  challengeEnd: "1700000600",
} as const;

const b32 = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const txh = (n: number): Hex => `0x${"f".repeat(60)}${n.toString(16).padStart(4, "0")}` as Hex;

function encodeLog(
  abi: readonly unknown[],
  address: Address,
  eventName: string,
  args: Record<string, unknown>,
  block: number,
  logIndex: number,
  txNo: number,
): RawLog {
  const event = abi.find((i) => (i as AbiEvent).type === "event" && (i as AbiEvent).name === eventName) as AbiEvent | undefined;
  if (!event) throw new Error(`no event ${eventName}`);
  const topics = encodeEventTopics({ abi: [event], eventName, args } as never) as Hex[];
  const nonIndexed = event.inputs.filter((i) => !i.indexed);
  const data = nonIndexed.length === 0 ? ("0x" as Hex) : encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]));
  return { address, topics, data, blockNumber: String(block), blockTimestamp: FIXTURE.blockTimestamp, transactionHash: txh(txNo), logIndex };
}

export function buildFixtureLogs(): RawLog[] {
  const F = FIXTURE;
  const T = (name: string, args: Record<string, unknown>, block: number, idx: number, tx: number) =>
    encodeLog(treasuryAbi as unknown as Abi, F.treasury, name, args, block, idx, tx);
  const FA = (name: string, args: Record<string, unknown>, block: number, idx: number, tx: number) =>
    encodeLog(escrowFactoryAbi as unknown as Abi, F.factory, name, args, block, idx, tx);
  const E = (escrow: Address, name: string, args: Record<string, unknown>, block: number, idx: number, tx: number) =>
    encodeLog(escrowAbi as unknown as Abi, escrow, name, args, block, idx, tx);
  const X = (from: Address, to: Address, value: bigint, block: number, idx: number, tx: number) =>
    encodeLog(usdcAbi, F.usdc, "Transfer", { from, to, value }, block, idx, tx);
  const amount = BigInt(F.amount);
  const bond = BigInt(F.bond);
  const created = (escrow: Address, orderId: Hex, seller: Address) => ({ escrow, orderId, buyer: F.treasury, seller, amount, termsHash: b32(9) });
  return [
    // The controller funds the treasury: the only event is USDC's Transfer.
    X(F.owner, F.treasury, BigInt(F.funding), 100, 0, 20),
    T("NodeCreated", { id: 1n, parent: 0n, key: F.orchestratorKey, cap: 50_000_000n, maxPerCall: 20_000_000n, expiry: 1_900_000_000n }, 101, 0, 1),
    T("AllowSet", { payee: F.seller, allowed: true }, 102, 0, 2),
    T("EscrowFactorySet", { factory: F.factory }, 102, 1, 2),
    // Order 1 (p1), honest: no bond.
    FA("OrderCreated", created(F.escrow1, b32(1), F.seller), 103, 0, 3),
    // Overflow-facilitator path: settle() -> USDC Transfer, then Paid, then the escrow's OrderFunded, one transaction.
    X(F.treasury, F.escrow1, amount, 104, 0, 4),
    T("Paid", { id: 1n, to: F.escrow1, value: amount, nonce: b32(0xaa) }, 104, 1, 4),
    E(F.escrow1, "OrderFunded", { balance: amount }, 104, 2, 4),
    E(F.escrow1, "KeyRevealed", { key: b32(0x77), challengeEnd: BigInt(F.challengeEnd) }, 105, 0, 5),
    E(F.escrow1, "Accepted", { signer: F.orchestratorKey, nodeId: 1n }, 106, 0, 6),
    E(F.escrow1, "PaidOut", { seller: F.seller, amount, bond: 0n }, 106, 1, 6),
    // Order 2 (p2), ghost seller with a 2.4 USDC bond: funded on the coinbase path, never reveals.
    FA("OrderCreated", created(F.escrow2, b32(2), F.seller), 107, 0, 7),
    T("Reserved", { digest: b32(0xd2), id: 1n, to: F.escrow2, value: amount, validBefore: 1_700_000_600n, nonce: b32(0xbb) }, 107, 1, 7),
    // Coinbase-facilitator path: the facilitator calls USDC directly, so there is no Paid; only Transfer + OrderFunded
    // (the seller's bond transfer touches no treasury address, so the indexer never fetches it; the balance shows it).
    X(F.treasury, F.escrow2, amount, 108, 0, 8),
    E(F.escrow2, "OrderFunded", { balance: BigInt(F.fundedWithBond) }, 108, 1, 8),
    // Missed reveal: claimTimeoutRefund() returns the whole balance (price + bond) to the treasury in one transfer.
    X(F.escrow2, F.treasury, amount + bond, 109, 0, 9),
    E(F.escrow2, "Refunded", { reason: "timeout" }, 109, 1, 9),
    // Owner actions approved in Coinbase Wallet: pause node 1 and raise its cap to 80 USDC (one send_calls batch).
    T("NodePaused", { id: 1n, by: F.owner }, 110, 1, 11),
    T("CapRaised", { id: 1n, oldCap: 50_000_000n, newCap: BigInt(F.raisedCap) }, 110, 3, 11),
    // release(d2) after validBefore: USDC had consumed the nonce, so nothing is refunded to the node's allowance.
    T("ReservationReleased", { digest: b32(0xd2), refunded: false }, 110, 2, 12),
    // Order 3 (p3): created but never funded in the treasury's view; its PaidOut must be refused by the state machine.
    FA("OrderCreated", created(F.escrow3, b32(3), F.seller), 111, 0, 13),
    E(F.escrow3, "PaidOut", { seller: F.seller, amount, bond: 0n }, 111, 1, 13),
    // Direct x402 API purchase (p4): settle() to a non-escrow payee. Expense books from the Transfer.
    X(F.treasury, F.apiSeller, BigInt(F.apiAmount), 112, 0, 15),
    T("Paid", { id: 1n, to: F.apiSeller, value: BigInt(F.apiAmount), nonce: b32(0xcc) }, 112, 1, 15),
    // Order 4 (p5), SIMULATED swap seller with a 2.4 USDC bond: funded, revealed, then a mismatch is proven onchain.
    FA("OrderCreated", created(F.escrow4, b32(4), F.cheater), 113, 0, 16),
    X(F.treasury, F.escrow4, amount, 113, 1, 17),
    T("Paid", { id: 1n, to: F.escrow4, value: amount, nonce: b32(0xdd) }, 113, 2, 17),
    E(F.escrow4, "OrderFunded", { balance: BigInt(F.fundedWithBond) }, 113, 3, 17),
    E(F.escrow4, "KeyRevealed", { key: b32(0x78), challengeEnd: BigInt(F.challengeEnd) }, 114, 0, 18),
    // complainMismatch(3, ...): CheatProven, the factory's CheatRecorded, the whole balance back, Refunded("mismatch").
    E(F.escrow4, "CheatProven", { seller: F.cheater, index: 3n }, 115, 0, 19),
    FA("CheatRecorded", { seller: F.cheater, escrow: F.escrow4 }, 115, 1, 19),
    X(F.escrow4, F.treasury, amount + bond, 115, 2, 19),
    E(F.escrow4, "Refunded", { reason: "mismatch" }, 115, 3, 19),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(new URL("./base-sepolia-logs.json", import.meta.url));
  writeFileSync(out, JSON.stringify({ simulated: true, note: "encoded from the generated contract ABIs; not a real deployment", ...FIXTURE, logs: buildFixtureLogs() }, null, 2) + "\n");
  console.log(`wrote ${out}`);
}
