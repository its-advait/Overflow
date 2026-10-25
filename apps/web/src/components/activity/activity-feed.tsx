"use client";

import type { ActivityEvent } from "@overflow/schemas";
import { Activity } from "lucide-react";
import { TxHash } from "@/components/shared/address";
import { EmptyState } from "@/components/shared/empty-state";
import { formatWhen } from "@/components/shared/panel";
import { SimulatedBadge } from "@/components/shared/simulated-badge";
import { Pill } from "@/components/shared/status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeEvent, type DescribeContext } from "@/lib/activity";
import { eventTone, isBlocked } from "@/lib/overview/events";
import { cn } from "@/lib/utils";
import { AmountCell, CounterpartyCell, openProps } from "./parts";

/** Every event in order, newest first, as the service wrote it. A row opens the detail drawer. */
export function ActivityFeed({ events, ctx, onOpen }: { events: readonly ActivityEvent[]; ctx: DescribeContext; onOpen: (e: ActivityEvent) => void }) {
  if (events.length === 0) {
    return <EmptyState icon={Activity} title="No events match" description="Every step the service takes lands here: proposals, authorizations, escrow events, refusals, model calls." />;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-36">Time</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Action</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Counterparty</TableHead>
          <TableHead>Tx</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((e) => {
          const d = describeEvent(e, ctx);
          const blocked = isBlocked(e);
          return (
            <TableRow
              key={e.id}
              data-testid="activity-row"
              data-id={e.id}
              data-kind={e.kind}
              className={cn("cursor-pointer align-top", blocked && "bg-danger/5 hover:bg-danger/10")}
              {...openProps(e, onOpen)}
            >
              <TableCell className="text-xs text-text-muted tnum whitespace-nowrap">{formatWhen(e.at)}</TableCell>
              <TableCell>
                <span className="flex flex-wrap items-center gap-1">
                  <Pill tone={eventTone(e.kind)}>{e.kind}</Pill>
                  {e.simulated ? <SimulatedBadge /> : null}
                </span>
              </TableCell>
              <TableCell className="text-xs whitespace-nowrap">{d.agent ?? <span className="text-text-muted">no agent</span>}</TableCell>
              <TableCell className="max-w-md">
                <p className={cn("line-clamp-2 text-xs break-words whitespace-normal", blocked ? "text-danger" : "text-text")} title={e.message}>
                  {d.action}
                </p>
                {blocked && e.decodedRevert ? <p className="mt-0.5 font-mono text-[11px] text-danger">{e.decodedRevert}</p> : null}
              </TableCell>
              <TableCell className="text-right">
                <AmountCell atomic={d.amountAtomic} />
              </TableCell>
              <TableCell>
                <CounterpartyCell value={d.counterparty} />
              </TableCell>
              <TableCell onClick={(x) => x.stopPropagation()}>{e.txHash ? <TxHash value={e.txHash} chars={4} /> : <span className="text-text-muted">—</span>}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
