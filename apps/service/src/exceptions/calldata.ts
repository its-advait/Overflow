import type { Address, ControllerAction, Hex } from "@overflow/schemas";
import { encodeFunctionData } from "viem";
import { treasuryAbi } from "../chain/abi.js";

// ---------------------------------------------------------------------------
// Prepared owner calls. The service ENCODES what the controller will approve
// in Coinbase Wallet (send_calls); it never signs or sends. Every call targets
// the treasury and carries no ETH. Only the three actions the exception types
// need are supported; anything else is refused rather than guessed.
// ---------------------------------------------------------------------------

export interface PreparedCall {
  target: Address;
  data: Hex;
  value: "0";
  summary: string;
}

export class UnsupportedControllerActionError extends Error {
  constructor(public readonly kind: ControllerAction["kind"]) {
    super(`no calldata builder for controller action "${kind}"`);
    this.name = "UnsupportedControllerActionError";
  }
}

export function buildControllerCall(action: ControllerAction, treasury: Address): PreparedCall {
  switch (action.kind) {
    case "set-allow":
      return {
        target: treasury,
        data: encodeFunctionData({ abi: treasuryAbi, functionName: "setAllow", args: [action.payee, action.allowed] }),
        value: "0",
        summary: `setAllow(${action.payee}, ${action.allowed}): ${action.allowed ? "allow" : "remove"} payee ${action.payee} on treasury ${treasury}`,
      };
    case "raise-cap":
      return {
        target: treasury,
        data: encodeFunctionData({ abi: treasuryAbi, functionName: "raiseCap", args: [BigInt(action.nodeId), BigInt(action.newCapAtomic)] }),
        value: "0",
        summary: `raiseCap(${action.nodeId}, ${action.newCapAtomic}): raise node ${action.nodeId}'s cap to ${action.newCapAtomic} atomic USDC on treasury ${treasury}`,
      };
    case "pause":
      return {
        target: treasury,
        data: encodeFunctionData({ abi: treasuryAbi, functionName: "pause", args: [BigInt(action.nodeId)] }),
        value: "0",
        summary: `pause(${action.nodeId}): pause node ${action.nodeId} and its subtree on treasury ${treasury}`,
      };
    default:
      throw new UnsupportedControllerActionError(action.kind);
  }
}
