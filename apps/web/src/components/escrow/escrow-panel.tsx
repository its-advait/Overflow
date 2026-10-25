"use client";

import type { ChainTransaction, EscrowChainState, EscrowOrder } from "@overflow/schemas";
import { TxHash } from "@/components/shared/address";
import { formatWhen, Panel } from "@/components/shared/panel";
import { Pill } from "@/components/shared/status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { confirmedLogs, deriveDiagram, formatUnix, liveDeadlines } from "@/lib/escrow/state";
import { cn } from "@/lib/utils";
import { StateDiagram } from "./state-diagram";
import { TermsTable } from "./terms-table";

function argsSummary(tx: ChainTransaction): string {
  return Object.entries(tx.args)
    .map(([k, v]) => `${k}=${typeof v === "string" && v.length > 20 ? `${v.slice(0, 10)}…${v.slice(-6)}` : String(v)}`)
    .join("  ");
}

/**
 * EscrowPanel: the state diagram with the current state lit, the two deadlines with live countdowns, the full terms
 * and every confirmed chain log for this order. Status comes from the chain read when the service has one, else
 * from the indexed events; the panel says which.
 */
export function EscrowPanel({
  escrow,
  chain,
  chainUnavailable,
  chainTransactions,
  nowSeconds,
}: {
  escrow: EscrowOrder;
  chain: EscrowChainState | null;
  chainUnavailable?: string | undefined;
  chainTransactions: readonly ChainTransaction[];
  nowSeconds: number;
}) {
  const diagram = deriveDiagram(escrow, chain, chainTransactions);
  const deadlines = liveDeadlines(escrow, chain, nowSeconds);
  const logs = confirmedLogs(chainTransactions);
  return (
    <Panel
      title="Escrow state"
      aside={
        <>
          <Pill tone={diagram.source === "chain" ? "success" : "muted"} title={diagram.source === "chain" ? `status() read at block ${chain?.blockNumber}` : "no chain reader; status from the indexed events"}>
            status from {diagram.source === "chain" ? "chain read" : "indexed events"}
          </Pill>
          {diagram.disagree ? (
            <Pill tone="warning" title={`chain says ${chain?.status}, stored row says ${escrow.status}; the indexer has not caught up`}>
              stored {escrow.status} ≠ chain {chain?.status}
            </Pill>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <StateDiagram diagram={diagram} />
        <div className="grid gap-3 sm:grid-cols-2" data-testid="escrow-deadlines">
          {deadlines.map((d) => (
            <div key={d.key} data-deadline={d.key} data-passed={d.passed} className={cn("rounded-xl border border-border p-3", d.passed ? "bg-surface-raised/60" : "bg-surface")}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">{d.label}</span>
                <span className={cn("tnum font-mono text-sm", d.passed ? "text-text-muted" : "text-text")}>{d.passed ? "passed" : d.countdown}</span>
              </div>
              <p className="mt-1 text-sm text-text">
                {formatUnix(d.at)} <span className="text-xs text-text-muted">({d.at.toString()})</span>
              </p>
              <p className="mt-1 text-xs text-text-muted">{d.consequence}</p>
            </div>
          ))}
        </div>
        <TermsTable escrow={escrow} chain={chain} chainUnavailable={chainUnavailable} />
        <div>
          <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">Chain events ({logs.length} confirmed)</h4>
          {logs.length === 0 ? (
            <p className="text-xs text-text-muted">No confirmed log for this order yet.</p>
          ) : (
            <Table data-testid="escrow-events">
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Transaction</TableHead>
                  <TableHead>Block</TableHead>
                  <TableHead>Observed</TableHead>
                  <TableHead>Decoded args</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((t) => (
                  <TableRow key={`${t.txHash}:${t.logIndex}`} data-event={t.eventName}>
                    <TableCell className="font-medium">{t.eventName}</TableCell>
                    <TableCell>
                      <TxHash value={t.txHash} />
                    </TableCell>
                    <TableCell className="tnum">{t.blockNumber}</TableCell>
                    <TableCell className="text-text-muted">{formatWhen(t.observedAt)}</TableCell>
                    <TableCell className="max-w-md truncate font-mono text-[11px] text-text-muted" title={JSON.stringify(t.args)}>
                      {argsSummary(t)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </Panel>
  );
}
