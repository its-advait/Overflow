import {
  authorizationFromJson,
  buildTransferTypedData,
  isAuthorizationLive,
  USDC_DOMAIN,
  X402_NETWORK_BASE_SEPOLIA,
  type PaymentPayload,
  type PaymentRequirements,
} from "@overflow/payment-client";
import { USDC, type Address, type Hex } from "@overflow/schemas";
import { decodeEventLog, getAddress, hashTypedData, recoverTypedDataAddress, type Account, type Log } from "viem";
import { decodeTreasuryRevert, shortMessage, type DecodedRevert } from "../chain/decode.js";
import { treasurySettleAbi, usdcSettleAbi } from "./abi.js";

// ---------------------------------------------------------------------------
// The Overflow facilitator's settle core (Leash apps/facilitator /settle, ported).
//
// It submits OverflowTreasury.settle() with the relayer key. It never calls
// USDC to move funds: the treasury does, and USDC asks the treasury (ERC-1271)
// before moving anything. Three outcomes, never conflated:
//   paid     receipt success, Paid log decoded, USDC consumed the nonce
//   blocked  simulation revert (nothing sent) or a reverted receipt (txHash)
//   unknown  sent but no usable receipt; the chain, not this code, decides
// A simulation that reverts is broadcast only when the caller asks for it
// (forceBroadcast), which the seller paywall allows only in DEMO_MODE so the
// attack demo gets its revert on Basescan.
// ---------------------------------------------------------------------------

export interface SettleInput {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  forceBroadcast: boolean;
}

export type SettleOutcome =
  | { outcome: "paid"; txHash: Hex; blockNumber: string; nodeId: string; payer: Address; digest: Hex }
  | { outcome: "blocked"; decoded: DecodedRevert; txHash?: Hex; digest?: Hex; payer?: Address; nodeId?: string }
  | { outcome: "unknown"; reason: string; digest: Hex; txHash?: Hex };

export interface Facilitator {
  settle(input: SettleInput): Promise<SettleOutcome>;
}

type SettleArgs = readonly [Address, bigint, bigint, bigint, Hex, Hex];

export interface SettleReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  logs: readonly Pick<Log, "address" | "data" | "topics">[];
}

/**
 * Structural subset of viem's public + wallet clients (pattern: chain/client.ts
 * LogSource). Tests implement it with a fake; createChainFacilitator binds the
 * real clients.
 */
export interface SettleChain {
  getBlockTimestamp(): Promise<bigint>;
  nodeOfKey(treasury: Address, key: Address): Promise<bigint>;
  authorizationState(treasury: Address, nonce: Hex): Promise<boolean>;
  /** Resolves when settle() would succeed; rejects with the viem error otherwise. */
  simulateSettle(treasury: Address, args: SettleArgs): Promise<void>;
  /** Broadcasts settle() and returns the tx hash. */
  sendSettle(treasury: Address, args: SettleArgs): Promise<Hex>;
  waitForReceipt(txHash: Hex): Promise<SettleReceipt>;
}

export interface ChainFacilitatorOptions {
  chain: SettleChain;
  treasury: Address;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function invalid(reason: string): SettleOutcome {
  return { outcome: "blocked", decoded: { name: "InvalidPayment", args: [], decoded: "InvalidPayment()", reason } };
}

/**
 * Requirement checks no client flag may bypass. Mirrors Leash checkRequirements
 * with the one difference the spec asks for: the amount must equal the quote
 * exactly, not merely cover it.
 */
export function checkSettleRequirements(input: SettleInput, treasury: Address, blockTimestamp: bigint): string | undefined {
  const { payload, requirements } = input;
  const a = payload.payload.authorization;
  if (!same(a.from, treasury)) return "authorization.from is not the treasury";
  if (!same(requirements.asset, USDC.address)) return "asset is not USDC";
  if (requirements.network !== X402_NETWORK_BASE_SEPOLIA) return `unsupported network ${requirements.network}`;
  if (requirements.scheme !== "exact") return `unsupported scheme ${requirements.scheme}`;
  if (!same(a.to, requirements.payTo)) return "authorization.to does not match payTo";
  if (!/^(0|[1-9]\d*)$/.test(requirements.amount)) return "paymentRequirements.amount is malformed";
  if (BigInt(a.value) !== BigInt(requirements.amount)) return "authorization.value does not equal the required amount";
  if (!same(payload.accepted.payTo, requirements.payTo) || payload.accepted.amount !== requirements.amount) {
    return "payload.accepted disagrees with the route's requirements";
  }
  const live = isAuthorizationLive(authorizationFromJson(a), blockTimestamp);
  if (!live.live) return live.reason === "expired" ? "authorization expired" : "authorization not yet valid";
  return undefined;
}

export function createChainFacilitator(opts: ChainFacilitatorOptions): Facilitator {
  const treasury = getAddress(opts.treasury);
  const { chain } = opts;

  return {
    async settle(input) {
      const blockTimestamp = await chain.getBlockTimestamp();
      const bad = checkSettleRequirements(input, treasury, blockTimestamp);
      if (bad) return invalid(bad);

      const authJson = input.payload.payload.authorization;
      const signature = input.payload.payload.signature;
      const authorization = authorizationFromJson(authJson);
      const typedData = buildTransferTypedData(USDC_DOMAIN, authorization);
      const digest = hashTypedData(typedData);

      let payer: Address;
      try {
        payer = getAddress(await recoverTypedDataAddress({ ...typedData, signature }));
      } catch (err) {
        return invalid(`signature does not recover: ${shortMessage(err)}`);
      }
      const nodeId = await chain.nodeOfKey(treasury, payer);
      const nodeIdStr = nodeId === 0n ? undefined : nodeId.toString();

      const args: SettleArgs = [
        getAddress(authorization.to),
        authorization.value,
        authorization.validAfter,
        authorization.validBefore,
        authorization.nonce,
        signature,
      ];

      // Always simulate first (free eth_call): it yields the decoded error even for a forced broadcast.
      let preDecoded: DecodedRevert | undefined;
      try {
        await chain.simulateSettle(treasury, args);
      } catch (err) {
        preDecoded = decodeTreasuryRevert(err);
        if (!input.forceBroadcast) {
          return { outcome: "blocked", decoded: preDecoded, digest, payer, ...(nodeIdStr ? { nodeId: nodeIdStr } : {}) };
        }
      }

      let txHash: Hex;
      try {
        txHash = await chain.sendSettle(treasury, args);
      } catch (err) {
        // Nothing we can prove was broadcast. A receipt-less send is unknown, not blocked.
        return { outcome: "unknown", reason: `send failed: ${shortMessage(err)}`, digest };
      }

      let receipt: SettleReceipt;
      try {
        receipt = await chain.waitForReceipt(txHash);
      } catch (err) {
        return { outcome: "unknown", reason: `no receipt: ${shortMessage(err)}`, digest, txHash };
      }

      if (receipt.status === "reverted") {
        const decoded = preDecoded ?? {
          name: "Unknown",
          args: [],
          decoded: 'Unknown("reverted on chain; simulation had passed")',
          reason: "settle() reverted on chain",
        };
        return { outcome: "blocked", decoded, txHash, digest, payer, ...(nodeIdStr ? { nodeId: nodeIdStr } : {}) };
      }

      let paidNodeId: string | undefined;
      for (const log of receipt.logs) {
        if (!same(log.address, treasury)) continue;
        try {
          const ev = decodeEventLog({ abi: treasurySettleAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
          if (ev.eventName === "Paid" && same(ev.args.nonce, authorization.nonce)) paidNodeId = ev.args.id.toString();
        } catch {
          /* not a Paid log */
        }
      }
      const consumed = await chain.authorizationState(treasury, authorization.nonce);
      if (!paidNodeId || !consumed) {
        return {
          outcome: "unknown",
          reason: !paidNodeId ? "receipt succeeded but carries no matching Paid event" : "USDC did not consume the nonce",
          digest,
          txHash,
        };
      }
      return { outcome: "paid", txHash, blockNumber: receipt.blockNumber.toString(), nodeId: paidNodeId, payer, digest };
    },
  };
}

// ---------------------------------------------------------------------------
// Real viem binding
// ---------------------------------------------------------------------------

export interface ViemSettleClients {
  publicClient: {
    getBlock(): Promise<{ timestamp: bigint }>;
    readContract(args: unknown): Promise<unknown>;
    simulateContract(args: unknown): Promise<unknown>;
    waitForTransactionReceipt(args: { hash: Hex }): Promise<{
      status: "success" | "reverted";
      blockNumber: bigint;
      logs: readonly Pick<Log, "address" | "data" | "topics">[];
    }>;
  };
  walletClient: { writeContract(args: unknown): Promise<Hex> };
  relayer: Account;
}

/** Wraps viem clients as a SettleChain. Kept tiny so the logic above is testable without a chain. */
export function viemSettleChain(c: ViemSettleClients): SettleChain {
  return {
    async getBlockTimestamp() {
      return (await c.publicClient.getBlock()).timestamp;
    },
    async nodeOfKey(treasury, key) {
      return (await c.publicClient.readContract({ address: treasury, abi: treasurySettleAbi, functionName: "nodeOfKey", args: [key] })) as bigint;
    },
    async authorizationState(treasury, nonce) {
      return (await c.publicClient.readContract({
        address: USDC.address,
        abi: usdcSettleAbi,
        functionName: "authorizationState",
        args: [treasury, nonce],
      })) as boolean;
    },
    async simulateSettle(treasury, args) {
      await c.publicClient.simulateContract({ account: c.relayer, address: treasury, abi: treasurySettleAbi, functionName: "settle", args });
    },
    async sendSettle(treasury, args) {
      return c.walletClient.writeContract({
        account: c.relayer,
        address: treasury,
        abi: treasurySettleAbi,
        functionName: "settle",
        args,
      });
    },
    async waitForReceipt(hash) {
      const r = await c.publicClient.waitForTransactionReceipt({ hash });
      return { status: r.status, blockNumber: r.blockNumber, logs: r.logs };
    },
  };
}
