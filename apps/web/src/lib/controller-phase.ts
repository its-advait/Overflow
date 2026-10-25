import type { ControllerRequest } from "@overflow/schemas";
import type { Tone } from "@/components/shared/status-pill";

/**
 * How a controller request reads in the UI. `done` is only ever the service's `status === "done"`,
 * which the indexer sets from the treasury event; a submission (approval link) is "awaiting approval",
 * never success.
 */
export type Phase = "pending" | "awaiting-approval" | "done" | "rejected";

export function phaseOf(r: ControllerRequest): Phase {
  if (r.status === "done") return "done";
  if (r.status === "rejected") return "rejected";
  return r.submission ? "awaiting-approval" : "pending";
}

export const PHASE_STYLE: Record<Phase, { label: string; tone: Tone; hint: string }> = {
  pending: { label: "PENDING", tone: "muted", hint: "Prepared owner call; the controller has not sent it yet." },
  "awaiting-approval": { label: "AWAITING APPROVAL", tone: "warning", hint: "Sent through Coinbase Wallet; the human has not approved it onchain." },
  done: { label: "DONE", tone: "success", hint: "The indexer stored the treasury event for this call." },
  rejected: { label: "REJECTED", tone: "danger", hint: "The controller declined this request." },
};

/** One line per action kind. Amounts stay atomic here; the components format them with Money. */
export function describeAction(r: ControllerRequest): string {
  const a = r.action;
  switch (a.kind) {
    case "set-allow":
      return `${a.allowed ? "Allow" : "Remove"} payee (treasury allowlist)`;
    case "raise-cap":
      return `Raise cap of node ${a.nodeId}`;
    case "pause":
      return `Pause node ${a.nodeId}`;
    case "unpause":
      return `Unpause node ${a.nodeId}`;
    case "set-floor":
      return "Set treasury floor";
    case "withdraw":
      return "Withdraw from treasury";
    case "set-escrow-factory":
      return "Set escrow factory";
  }
}
