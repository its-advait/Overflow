import { ESCROW_STATUSES, overflowEscrowAbi, type Address, type EscrowStatus, type Hex } from "@overflow/schemas";
import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import type { EscrowReadPort } from "../api/ports.js";

const balanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** The contract's `enum Status` index -> name (Created, Funded, Revealed, Settled, Refunded). */
export function escrowStatusFromIndex(index: number | bigint): EscrowStatus {
  const i = Number(index);
  const status = ESCROW_STATUSES[i];
  if (status === undefined) throw new Error(`escrow status index ${i} out of range`);
  return status;
}

/**
 * EscrowReadPort over a viem public client: status(), challengeEnd(), revealedKey() on the escrow and
 * USDC balanceOf(escrow), all pinned to one block so the gates are judged against that block's clock.
 * No account, no signing; the port cannot move funds.
 */
export function viemEscrowRead(rpcUrl: string, usdc: Address): EscrowReadPort {
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  return {
    async latest() {
      const block = await client.getBlock({ blockTag: "latest" });
      return { blockNumber: block.number, blockTimestamp: block.timestamp };
    },
    async state(escrow) {
      const blockNumber = await client.getBlockNumber();
      const view = (functionName: "status" | "challengeEnd" | "revealedKey") =>
        client.readContract({ address: escrow, abi: overflowEscrowAbi, functionName, blockNumber });
      const [status, challengeEnd, revealedKey, balance] = await Promise.all([
        view("status"),
        view("challengeEnd"),
        view("revealedKey"),
        client.readContract({ address: usdc, abi: balanceAbi, functionName: "balanceOf", args: [escrow], blockNumber }),
      ]);
      return {
        status: escrowStatusFromIndex(status as number),
        challengeEnd: BigInt(challengeEnd as bigint | number),
        revealedKey: revealedKey as Hex,
        balance: BigInt(balance as bigint),
      };
    },
  };
}
