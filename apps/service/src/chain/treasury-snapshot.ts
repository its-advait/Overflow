import type { Address } from "viem";
import type { BalanceReader, LogSource, TreasuryReader } from "./log-source.js";

/** What the treasury holds and has promised, read from the chain at one block. Decimal strings of atomic USDC. */
export interface TreasurySnapshot {
  treasury: Address;
  usdc: Address;
  blockNumber: string;
  /** USDC.balanceOf(treasury). */
  balanceAtomic: string;
  /** OverflowTreasury.reservedTotal(): USDC held back for open reservations; the floor check counts it. */
  reservedTotalAtomic: string;
  readAt: string;
}

/**
 * Reads the two numbers the overview's Treasury and Reserved cards show, both pinned to the same block so they
 * describe one moment. Nothing is cached or estimated: every call is an RPC read.
 */
export async function readTreasurySnapshot(
  reader: Pick<LogSource, "getBlockNumber"> & BalanceReader & TreasuryReader,
  addresses: { treasury: Address; usdc: Address },
  now: () => Date = () => new Date(),
): Promise<TreasurySnapshot> {
  const block = await reader.getBlockNumber();
  const [balance, reserved] = await Promise.all([
    reader.balanceOf(addresses.usdc, addresses.treasury, block),
    reader.reservedTotal(addresses.treasury, block),
  ]);
  return {
    treasury: addresses.treasury,
    usdc: addresses.usdc,
    blockNumber: block.toString(),
    balanceAtomic: balance.toString(),
    reservedTotalAtomic: reserved.toString(),
    readAt: now().toISOString(),
  };
}
