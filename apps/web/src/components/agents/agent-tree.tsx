"use client";

import type { ControllerRequest, TreasuryNodeView } from "@overflow/schemas";
import type { TreeNode } from "@/lib/tree";
import { AgentCard } from "./agent-card";
import type { RequestMode } from "./agent-menu";

/** Root, children, grandchildren: each level indents under a connector line (Leash dashboard layout). */
export function AgentTree({
  roots,
  requests,
  selectedId,
  onSelect,
  onAction,
}: {
  roots: readonly TreeNode<TreasuryNodeView>[];
  requests: readonly ControllerRequest[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onAction: (node: TreasuryNodeView, mode: RequestMode) => void;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {roots.map((t) => (
        <li key={t.node.id} className="flex flex-col gap-3">
          <AgentCard
            node={t.node}
            requests={requests}
            selected={selectedId === t.node.id}
            onSelect={() => onSelect(t.node.id)}
            onAction={(mode) => onAction(t.node, mode)}
          />
          {t.children.length > 0 ? (
            <div className="ml-4 border-l-2 border-border pl-4 sm:ml-6 sm:pl-6">
              <AgentTree roots={t.children} requests={requests} selectedId={selectedId} onSelect={onSelect} onAction={onAction} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
