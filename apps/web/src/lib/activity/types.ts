import type { ActivityKind } from "@overflow/schemas";

/**
 * The feed's "type" filter. Every ActivityKind belongs to exactly one group (tested against the
 * schema's enum), so a new kind fails the build of the test instead of silently vanishing from a filter.
 */
export const TYPE_GROUPS = {
  money: ["payment.authorized", "treasury.paid", "treasury.reserved", "treasury.released", "usdc.transfer"],
  escrow: ["escrow.created", "escrow.funded", "escrow.revealed", "escrow.accepted", "escrow.settled", "escrow.refunded", "escrow.swept"],
  blocked: ["policy.blocked"],
  purchases: ["purchase.proposed", "purchase.status", "sample.judged", "complaint.built"],
  agents: [
    "mission.created",
    "mission.requirement_edited",
    "mission.confirmed",
    "mission.run",
    "agent.tool_call",
    "agent.tool_result",
    "agent.report",
    "delegation.signed",
    "delegation.relayed",
  ],
  decisions: ["oracle.model_call", "oracle.recommendation", "fusion.decision"],
  controller: ["controller.requested", "controller.submitted", "controller.resolved", "exception.opened", "treasury.node", "treasury.policy"],
  books: ["reconciliation.ok", "reconciliation.difference"],
  sellers: ["seller.flagged", "seller.cheat-recorded", "indexer.unconfirmed"],
} as const satisfies Record<string, readonly ActivityKind[]>;

export type TypeGroup = keyof typeof TYPE_GROUPS;

export const TYPE_GROUP_LABEL: Record<TypeGroup, string> = {
  money: "Payments (authorize, settle, transfer)",
  escrow: "Escrow",
  blocked: "Blocked",
  purchases: "Purchases and evidence",
  agents: "Agents and missions",
  decisions: "Oracle and Fusion",
  controller: "Controller and exceptions",
  books: "Reconciliation",
  sellers: "Sellers and indexer",
};

export const TYPE_GROUP_ORDER = Object.keys(TYPE_GROUPS) as TypeGroup[];

export function isTypeGroup(value: string | null | undefined): value is TypeGroup {
  return value !== null && value !== undefined && Object.hasOwn(TYPE_GROUPS, value);
}

const GROUP_OF = new Map<ActivityKind, TypeGroup>(
  TYPE_GROUP_ORDER.flatMap((g) => (TYPE_GROUPS[g] as readonly ActivityKind[]).map((k) => [k, g] as const)),
);

export function groupOf(kind: ActivityKind): TypeGroup {
  const g = GROUP_OF.get(kind);
  if (!g) throw new Error(`activity kind ${kind} has no type group`);
  return g;
}
