"use client";

import Link from "next/link";
import { useState } from "react";
import { explorerUrl, type ExceptionRecord, type ReconciliationRun } from "@overflow/schemas";
import { Address } from "@/components/shared/address";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { Field, formatWhen, Panel } from "@/components/shared/panel";
import { EscrowStatusPill, Pill } from "@/components/shared/status-pill";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { exceptionFor, materialRows, reconciliationRows, RUN_STATUS_STYLE } from "@/lib/ledger/reconciliation";
import { EXCEPTION_STATUS_STYLE } from "@/lib/ledger/exceptions";

/**
 * Chain vs ledger at the last run's block: the treasury, every escrow order the
 * run checked (open ones first) and any event-coverage gap. Differences above
 * materiality are listed with the exception they opened. "Run reconciliation"
 * calls POST /api/reconciliation/run and shows only what comes back (501 when
 * the service has no chain reader).
 */
export function ReconciliationPanel({
  lastRun,
  note,
  openExceptions,
  onRan,
}: {
  lastRun: ReconciliationRun | null;
  note?: string | undefined;
  openExceptions: readonly ExceptionRecord[];
  /** Called with the run the service returned; the parent refetches. */
  onRan: (run: ReconciliationRun) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await api.runReconciliation();
      onRan(r.run);
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
    }
  };

  const runButton = (
    <Button size="sm" variant="outline" onClick={run} disabled={running}>
      {running ? "Running…" : "Run reconciliation"}
    </Button>
  );

  if (!lastRun) {
    return (
      <div className="flex flex-col gap-4">
        {error ? <ErrorState error={error} title="Reconciliation did not run" /> : null}
        <EmptyState title="No reconciliation run recorded" description={note ?? "Runs happen after every indexer poll that stores new logs, or on demand."} action={runButton} />
      </div>
    );
  }

  const rows = reconciliationRows(lastRun);
  const material = materialRows(rows);
  const status = RUN_STATUS_STYLE[lastRun.status];

  return (
    <div className="flex flex-col gap-6">
      {error ? <ErrorState error={error} title="Reconciliation did not run" /> : null}
      <Panel
        title={
          <span className="flex items-center gap-2">
            Last run
            <Pill tone={status.tone} title={status.hint}>
              {status.label}
            </Pill>
          </span>
        }
        aside={runButton}
      >
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Ran at">{formatWhen(lastRun.ranAt)}</Field>
          <Field label="Trigger">{lastRun.trigger}</Field>
          <Field label="Block">
            <a href={explorerUrl("block", lastRun.blockNumber)} target="_blank" rel="noreferrer noopener" className="font-mono text-blue hover:underline">
              {lastRun.blockNumber}
            </a>
          </Field>
          <Field label="Materiality">
            <Money atomic={lastRun.materialityAtomic} size="sm" />
          </Field>
          <Field label="Checked">
            {lastRun.escrowsChecked} escrow{lastRun.escrowsChecked === 1 ? "" : "s"}, {lastRun.eventsChecked} event{lastRun.eventsChecked === 1 ? "" : "s"}
          </Field>
        </dl>
      </Panel>

      <Panel title="Chain vs ledger" aside={<span className="text-xs text-text-muted">the chain is the bank; the ledger is the books</span>}>
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Check</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Chain</TableHead>
                <TableHead className="text-right">Ledger</TableHead>
                <TableHead className="text-right">Difference</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.subject}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm text-text">
                        {r.purchaseId ? (
                          <Link href={`/purchases/${encodeURIComponent(r.purchaseId)}`} className="hover:underline">
                            {r.label}
                          </Link>
                        ) : (
                          r.label
                        )}
                      </span>
                      {r.escrowAddress ? <Address value={r.escrowAddress} /> : null}
                      {r.detail ? <span className="text-xs text-text-muted">{r.detail}</span> : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {r.escrowStatus ? <EscrowStatusPill status={r.escrowStatus} /> : r.kind === "treasury" ? <Pill tone="blue">treasury</Pill> : <Pill tone="muted">event</Pill>}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.chainAtomic !== undefined ? (
                      <span className="flex flex-col items-end">
                        <Money atomic={r.chainAtomic} size="sm" unit={null} />
                        {r.kind === "escrow" && r.expectedAtomic !== undefined && r.expectedAtomic !== r.chainAtomic ? (
                          <span className="text-[10px] text-text-muted">
                            minus bond = <Money atomic={r.expectedAtomic} size="sm" unit={null} muted />
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-xs text-text-muted" title="No balance read: an unfunded or closed order holds nothing of the treasury's">
                        {r.kind === "event-coverage" ? "—" : "expects 0"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money atomic={r.ledgerAtomic} size="sm" unit={null} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money atomic={r.differenceAtomic} size="sm" unit={null} signed />
                  </TableCell>
                  <TableCell className="text-right">
                    {r.differenceAtomic === 0n && r.kind !== "event-coverage" ? (
                      <Pill tone="success">match</Pill>
                    ) : r.material ? (
                      <Pill tone="danger" title="Above materiality: an exception is open for the controller">material</Pill>
                    ) : (
                      <Pill tone="muted" title="Within materiality; recorded, no exception">immaterial</Pill>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <Panel title="Exceptions above materiality">
        {material.length === 0 ? (
          <p className="text-sm text-text-muted">None. Every difference in this run is within {<Money atomic={lastRun.materialityAtomic} size="sm" />}.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {material.map((r) => {
              const ex = exceptionFor(r, openExceptions);
              return (
                <li key={r.subject} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
                  <span className="flex flex-col">
                    <span className="text-sm text-text">{r.label}</span>
                    <span className="text-xs text-text-muted">{r.detail}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Money atomic={r.differenceAtomic} size="sm" signed />
                    {ex ? (
                      <Link href="/ledger?view=exceptions" className="text-xs text-blue hover:underline">
                        exception {ex.id}
                        <Pill tone={EXCEPTION_STATUS_STYLE[ex.status].tone} className="ml-1">
                          {EXCEPTION_STATUS_STYLE[ex.status].label}
                        </Pill>
                      </Link>
                    ) : (
                      <span className="text-xs text-text-muted" title="The exception for this subject was already decided, or the run opened one that is not in this list">
                        no open exception
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
