import type { ActivityEvent, ActivityKind } from "@overflow/schemas";
import type { Tone } from "@/components/shared/status-pill";

/** The Blocked lane: a treasury policy revert, or any event carrying a decoded revert. */
export function isBlocked(e: ActivityEvent): boolean {
  return e.kind === "policy.blocked" || e.decodedRevert !== undefined;
}

/** The reason to show beside a blocked event: the decoded revert when the service has one, else its message. */
export function blockedReason(e: ActivityEvent): string | undefined {
  if (!isBlocked(e)) return undefined;
  return e.decodedRevert ?? e.message;
}

/** Newest first by time, then id (ids are stable; times can tie in a batch). */
export function latestEvents(events: readonly ActivityEvent[], limit: number): ActivityEvent[] {
  return [...events].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, limit);
}

/** The three money events keep their colors (authorization blue, escrow funding cyan, settlement success / warning); blocked is danger. */
export function eventTone(kind: ActivityKind): Tone {
  if (kind === "policy.blocked") return "danger";
  if (kind === "escrow.settled") return "success";
  if (kind === "escrow.refunded" || kind === "escrow.bond-forfeited" || kind === "seller.flagged" || kind === "reconciliation.difference") return "warning";
  if (kind.startsWith("escrow.")) return "cyan";
  if (kind === "payment.authorized" || kind.startsWith("treasury.")) return "blue";
  if (kind.startsWith("agent.") || kind.startsWith("mission.") || kind.startsWith("delegation.")) return "violet";
  return "muted";
}
