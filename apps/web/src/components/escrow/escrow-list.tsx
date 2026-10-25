"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Address } from "@/components/shared/address";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { formatWhen } from "@/components/shared/panel";
import { SimulatedBadge } from "@/components/shared/simulated-badge";
import { SkeletonRows } from "@/components/shared/skeleton";
import { EscrowStatusPill, Pill, StatusPill } from "@/components/shared/status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useApiQuery, useLastGood } from "@/lib/use-api";

/** Activity kinds after which an order's row may have changed. */
const REFRESH_KINDS = new Set(["escrow.created", "escrow.funded", "escrow.revealed", "escrow.accepted", "escrow.settled", "escrow.refunded", "escrow.swept", "seller.flagged", "complaint.built", "sample.judged"]);
const POLL_MS = 15_000;

/** /escrow: every per-order escrow with its contract status (from indexed events), purchase status and complaint state. */
export function EscrowList() {
  const query = useApiQuery(() => api.listEscrows(), []);
  const data = useLastGood(query.data);
  const { reload } = query;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.subscribe((m) => {
      if (m.type !== "activity" || !REFRESH_KINDS.has(m.event.kind)) return;
      clearTimeout(timer);
      timer = setTimeout(reload, 300);
    });
    const poll = setInterval(reload, POLL_MS);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      unsubscribe();
    };
  }, [reload]);

  if (query.error && !data) return <ErrorState error={query.error} title="Could not list the escrows" />;
  if (!data) return <SkeletonRows rows={6} />;
  if (data.escrows.length === 0) return <EmptyState title="No escrow orders" description="Orders appear here once the factory's OrderCreated log is indexed." />;

  return (
    <Table data-testid="escrow-list">
      <TableHeader>
        <TableRow>
          <TableHead>Resource</TableHead>
          <TableHead>Escrow</TableHead>
          <TableHead>Seller</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">Bond</TableHead>
          <TableHead>Escrow state</TableHead>
          <TableHead>Purchase</TableHead>
          <TableHead>Complaint</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.escrows.map((e) => (
          <TableRow key={e.id} data-testid="escrow-row" data-purchase-id={e.purchaseId} data-status={e.status}>
            <TableCell>
              <Link href={`/escrow/${encodeURIComponent(e.purchaseId)}`} className="flex flex-col gap-0.5 hover:text-cyan">
                <span className="flex items-center gap-2 text-sm font-medium text-text">
                  {e.resource?.title ?? e.purchaseId}
                  {e.simulated ? <SimulatedBadge what="seller or dataset" /> : null}
                </span>
                <span className="text-[11px] text-text-muted">{e.resource?.sellerId ?? "unknown seller"} · {e.purchaseId}</span>
              </Link>
            </TableCell>
            <TableCell>
              <Address value={e.escrowAddress} />
            </TableCell>
            <TableCell>
              <Address value={e.sellerAddress} />
            </TableCell>
            <TableCell className="text-right">
              <Money atomic={e.amountAtomic} size="sm" />
            </TableCell>
            <TableCell className="text-right">
              <Money atomic={e.bondAtomic} size="sm" muted />
            </TableCell>
            <TableCell>
              <span className="flex items-center gap-1.5">
                <EscrowStatusPill status={e.status} />
                {e.refundReason ? <span className="font-mono text-[11px] text-text-muted">{e.refundReason}</span> : null}
              </span>
            </TableCell>
            <TableCell>
              <StatusPill status={e.purchaseStatus} />
            </TableCell>
            <TableCell>{e.complaint ? <Pill tone={e.complaint === "proven" ? "danger" : e.complaint === "rejected" ? "muted" : "blue"}>{e.complaint}</Pill> : <span className="text-xs text-text-muted">—</span>}</TableCell>
            <TableCell className="text-text-muted">{formatWhen(e.updatedAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
