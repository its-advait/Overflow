"use client";

import { MoreHorizontal, PauseCircle, TrendingUp, UserPlus } from "lucide-react";
import type { TreasuryNodeView } from "@overflow/schemas";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export type RequestMode = "pause" | "raise-cap" | "add-payee";

/**
 * The Leash kebab. Every item opens a request dialog; none of them changes anything itself.
 * The service turns the request into a pending ControllerRequest the owner approves onchain.
 */
export function AgentMenu({ node, onAction }: { node: TreasuryNodeView; onAction: (mode: RequestMode) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for node ${node.id}`} />}>
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {/* Base UI: a menu label must live inside a group. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-text-muted">Propose to the controller</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onAction("pause")} disabled={node.paused}>
            <PauseCircle />
            {node.paused ? "Already paused onchain" : "Pause"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onAction("raise-cap")}>
            <TrendingUp />
            Raise cap
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onAction("add-payee")}>
          <UserPlus />
          Add payee (treasury allowlist)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
