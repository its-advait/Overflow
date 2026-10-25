import { isOnchainExceptionType, type ExceptionRecord, type ExceptionStatus, type ExceptionType } from "@overflow/schemas";
import type { Tone } from "@/components/shared/status-pill";

// Exceptions (SPEC "When it asks a human"). Exhaustive records so a new type or
// status fails typecheck here before it renders without a label.

export const EXCEPTION_TYPE_STYLE: Record<ExceptionType, { label: string; tone: Tone; onchain: boolean; hint: string }> = {
  NEW_PAYEE: { label: "New payee", tone: "blue", onchain: true, hint: "Resolved by the controller's setAllow() in Coinbase Wallet." },
  CAP_RAISE: { label: "Budget raise", tone: "blue", onchain: true, hint: "Resolved by the controller's raiseCap() in Coinbase Wallet." },
  PAUSE_REQUEST: { label: "Pause request", tone: "danger", onchain: true, hint: "Resolved by the controller's pause() in Coinbase Wallet." },
  UNCLEAR_LICENSE: { label: "Unclear license", tone: "violet", onchain: false, hint: "The controller decides offchain." },
  LOW_CONFIDENCE_SAMPLE: { label: "Low-confidence sample", tone: "violet", onchain: false, hint: "The controller decides offchain." },
  RECONCILIATION_DIFF: { label: "Reconciliation difference", tone: "warning", onchain: false, hint: "Chain and books disagree above materiality. The chain wins on balances; the ledger is corrected with a stated reason." },
  DISPUTE_WITHOUT_PROOF: { label: "Dispute without proof", tone: "violet", onchain: false, hint: "The controller decides offchain." },
};

export const EXCEPTION_STATUS_STYLE: Record<ExceptionStatus, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "warning" },
  resolved: { label: "Resolved", tone: "success" },
  dismissed: { label: "Dismissed", tone: "muted" },
};

export interface DecideOption {
  enabled: boolean;
  /** Why the button is disabled, in the service's own terms. */
  reason?: string | undefined;
}

/**
 * Which decisions the service would accept from `decidedBy`: approve is never
 * offered for onchain types (the indexed treasury event approves them), nothing
 * is offered once decided, and the requester may not decide its own exception.
 */
export function decideOptions(exception: ExceptionRecord, decidedBy: string): { approve: DecideOption; reject: DecideOption } {
  if (exception.status !== "open") {
    const reason = `already ${exception.status}`;
    return { approve: { enabled: false, reason }, reject: { enabled: false, reason } };
  }
  if (decidedBy.trim().length > 0 && exception.requestedBy === decidedBy.trim()) {
    const reason = `${decidedBy.trim()} raised this exception and cannot decide it`;
    return { approve: { enabled: false, reason }, reject: { enabled: false, reason } };
  }
  if (isOnchainExceptionType(exception.type)) {
    return {
      approve: { enabled: false, reason: "approved only by the controller's treasury call in Coinbase Wallet; the indexer closes it when the event is stored" },
      reject: { enabled: true },
    };
  }
  return { approve: { enabled: true }, reject: { enabled: true } };
}
