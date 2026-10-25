import { createRepositories, type Executor } from "@overflow/database";
import { canTransition, type ActivityEvent, type Hex, type PurchaseRecord } from "@overflow/schemas";
import type { PurchaseService, TransitionSource } from "../orchestration/purchase-service.js";
import { REVERT_REASONS } from "./abi.js";
import type { ActivityBus } from "./bus.js";
import { decodeTreasuryRevert, type DecodedRevert } from "./decode.js";

// ---------------------------------------------------------------------------
// Failed transactions reported by the facilitator / payment adapters: a
// treasury revert (policy check), a USDC Error(string), or an RPC failure.
// They become `policy.blocked` activity events carrying the decoded reason
// (the Blocked lane) and, when a purchase is named, a REJECTED transition
// through PurchaseService. No chain_transactions row: nothing was emitted.
// ---------------------------------------------------------------------------

export interface FailedTransactionInput {
  purchaseId?: string | undefined;
  /** Hash of the reverted transaction when one was broadcast. */
  txHash?: Hex | undefined;
  /** The viem error (or raw revert data) to decode. */
  error?: unknown;
  /** Already-decoded form, e.g. "OverBudget(3)", when the caller decoded it. */
  decodedRevert?: string | undefined;
  source?: TransitionSource | undefined;
  agentId?: string | undefined;
  simulated?: boolean | undefined;
}

export interface FailedTransactionDeps {
  db: Executor;
  purchases: PurchaseService;
  bus?: ActivityBus | undefined;
}

export interface FailedTransactionResult {
  decoded: DecodedRevert;
  event: ActivityEvent;
  purchase?: PurchaseRecord | undefined;
}

function fromDecodedString(decodedRevert: string): DecodedRevert {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/s.exec(decodedRevert.trim());
  const name = m?.[1] ?? "Unknown";
  const args = m?.[2] ? m[2].split(",").map((s) => s.trim()).filter(Boolean) : [];
  return { name, args, decoded: decodedRevert, reason: REVERT_REASONS[name] ?? decodedRevert };
}

export async function recordFailedTransaction(
  deps: FailedTransactionDeps,
  input: FailedTransactionInput,
): Promise<FailedTransactionResult> {
  const decoded = input.decodedRevert ? fromDecodedString(input.decodedRevert) : decodeTreasuryRevert(input.error);
  const source: TransitionSource = input.source ?? { kind: "adapter", reference: "facilitator" };
  const repos = createRepositories(deps.db);

  const purchase = input.purchaseId ? await repos.purchases.getById(input.purchaseId) : undefined;
  if (purchase && canTransition(purchase.status, "REJECTED")) {
    const r = await deps.purchases.transition(purchase.id, "REJECTED", {
      reason: `transaction failed: ${decoded.reason}`,
      source,
      decodedRevert: decoded.decoded,
      ...(input.txHash ? { txHash: input.txHash } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      simulated: input.simulated ?? false,
    });
    return { decoded, event: r.event, purchase: r.purchase };
  }

  const event = await repos.activityEvents.insert({
    kind: "policy.blocked",
    message: `blocked: ${decoded.decoded}: ${decoded.reason} [${source.kind}:${source.reference}]`,
    decodedRevert: decoded.decoded,
    ...(input.txHash ? { txHash: input.txHash } : {}),
    ...(purchase ? { purchaseId: purchase.id, missionId: purchase.missionId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    simulated: input.simulated ?? false,
  });
  deps.bus?.publish(event);
  return { decoded, event, purchase };
}
