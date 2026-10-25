"use client";

import Link from "next/link";
import { useState } from "react";
import type { ExceptionStatus } from "@overflow/schemas";
import { Address, Mono } from "@/components/shared/address";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { Field, formatWhen } from "@/components/shared/panel";
import { Pill } from "@/components/shared/status-pill";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { DecideExceptionResponse, ExceptionWithRequest } from "@/lib/api/contracts";
import { decideOptions, EXCEPTION_STATUS_STYLE, EXCEPTION_TYPE_STYLE } from "@/lib/ledger/exceptions";

export type ExceptionsFilter = ExceptionStatus | "all";
const FILTERS: readonly ExceptionsFilter[] = ["open", "resolved", "dismissed", "all"];

/**
 * Every case where Overflow asked a human, with the controller's decide actions
 * (POST /api/exceptions/:id/decide). Onchain types (new payee, budget raise,
 * pause) show the prepared Coinbase Wallet call and can only be rejected here;
 * their approval is the indexed treasury event. A decision's outcome is shown
 * only from the service's response.
 */
export function ExceptionsList({
  exceptions,
  filter,
  onFilter,
  onDecided,
}: {
  exceptions: readonly ExceptionWithRequest[];
  filter: ExceptionsFilter;
  onFilter: (f: ExceptionsFilter) => void;
  onDecided: (r: DecideExceptionResponse) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Button key={f} size="sm" variant={f === filter ? "default" : "outline"} onClick={() => onFilter(f)} aria-pressed={f === filter}>
            {f === "all" ? "All" : EXCEPTION_STATUS_STYLE[f].label}
          </Button>
        ))}
        <span className="text-xs text-text-muted">
          {exceptions.length} exception{exceptions.length === 1 ? "" : "s"}
        </span>
      </div>
      {exceptions.length === 0 ? (
        <EmptyState title={`No ${filter === "all" ? "" : filter + " "}exceptions`} description="Overflow asks a human only for the SPEC's seven cases. Nothing is waiting here." />
      ) : (
        <ul className="flex flex-col gap-4">
          {exceptions.map((e) => (
            <ExceptionCard key={e.id} exception={e} onDecided={onDecided} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ExceptionCard({ exception: e, onDecided }: { exception: ExceptionWithRequest; onDecided: (r: DecideExceptionResponse) => void }) {
  const type = EXCEPTION_TYPE_STYLE[e.type];
  const status = EXCEPTION_STATUS_STYLE[e.status];
  return (
    <li className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <Pill tone={type.tone} title={type.hint}>
              {type.label}
            </Pill>
            <Pill tone={status.tone}>{status.label}</Pill>
            {type.onchain ? <Pill tone="muted" title="Resolution is a treasury owner call the controller approves in Coinbase Wallet">onchain</Pill> : null}
            <span className="font-mono text-xs text-text-muted">{e.id}</span>
          </span>
          <p className="text-sm text-text">{e.reason}</p>
        </div>
        <div className="text-right">
          {e.amountAtomic !== undefined ? <Money atomic={e.amountAtomic} size="lg" /> : <span className="text-sm text-text-muted">no amount</span>}
        </div>
      </div>

      <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Opened">{formatWhen(e.openedAt)}</Field>
        <Field label="Requested by">{e.requestedBy ?? "—"}</Field>
        <Field label="Subject">{e.subject ? <span className="font-mono text-xs">{e.subject}</span> : "—"}</Field>
        <Field label="Purchase">
          {e.purchaseId ? (
            <Link href={`/purchases/${encodeURIComponent(e.purchaseId)}`} className="font-mono text-xs text-blue hover:underline">
              {e.purchaseId}
            </Link>
          ) : (
            "—"
          )}
        </Field>
        {e.status !== "open" ? (
          <>
            <Field label="Decision">
              {e.decision ?? "—"} by {e.resolvedBy ?? "—"}
              {e.resolvedAt ? ` · ${formatWhen(e.resolvedAt)}` : ""}
            </Field>
            <Field label="Stated reason">{e.decisionReason ?? "—"}</Field>
          </>
        ) : null}
      </dl>

      {e.request ? (
        <div className="mt-4 rounded-lg border border-border bg-surface-raised/40 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">Prepared controller call (Coinbase Wallet send_calls)</span>
            <Pill tone={e.request.status === "done" ? "success" : e.request.status === "rejected" ? "muted" : "blue"}>{e.request.status}</Pill>
          </div>
          <p className="text-sm text-text">{e.request.summary}</p>
          <dl className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="Target">
              <Address value={e.request.target} />
            </Field>
            <Field label="Calldata">
              <Mono value={e.request.data} className="text-xs" />
            </Field>
          </dl>
          <p className="mt-2 text-xs text-text-muted">Approval happens in the controller&apos;s wallet, never here. The indexer closes this exception when the treasury event is stored.</p>
        </div>
      ) : null}

      {e.status === "open" ? <DecideForm exception={e} onDecided={onDecided} /> : null}
    </li>
  );
}

const INPUT = "h-9 rounded-lg border border-border bg-surface px-3 text-sm text-text";

function DecideForm({ exception: e, onDecided }: { exception: ExceptionWithRequest; onDecided: (r: DecideExceptionResponse) => void }) {
  const [decidedBy, setDecidedBy] = useState("controller");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<DecideExceptionResponse | null>(null);
  const options = decideOptions(e, decidedBy);
  const ready = decidedBy.trim().length > 0 && reason.trim().length > 0 && !pending && !result;

  const decide = async (decision: "approve" | "reject") => {
    setPending(decision);
    setError(null);
    try {
      const r = await api.decideException(e.id, { decidedBy: decidedBy.trim(), decision, reason: reason.trim() });
      setResult(r);
      onDecided(r);
    } catch (err) {
      setError(err);
    } finally {
      setPending(null);
    }
  };

  if (result) {
    const s = EXCEPTION_STATUS_STYLE[result.exception.status];
    return (
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
        <span className="text-text-muted">Service recorded:</span>
        <Pill tone={s.tone}>{s.label}</Pill>
        <span className="text-text">
          {result.exception.decision} by {result.exception.resolvedBy}
        </span>
        {result.request ? <Pill tone="muted">request {result.request.status}</Pill> : null}
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border p-3">
      <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">Decide</span>
      {error ? <ErrorState error={error} title="Decision refused" /> : null}
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Decided by
          <input className={INPUT} value={decidedBy} onChange={(ev) => setDecidedBy(ev.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Stated reason (recorded on the exception)
          <textarea className="min-h-9 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text" rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => decide("approve")} disabled={!ready || !options.approve.enabled} title={options.approve.reason}>
          {pending === "approve" ? "Approving…" : "Approve"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => decide("reject")} disabled={!ready || !options.reject.enabled} title={options.reject.reason}>
          {pending === "reject" ? "Rejecting…" : "Reject"}
        </Button>
        {!options.approve.enabled && options.approve.reason ? <span className="text-xs text-text-muted">Approve: {options.approve.reason}.</span> : null}
        {!options.reject.enabled && options.reject.reason ? <span className="text-xs text-text-muted">Reject: {options.reject.reason}.</span> : null}
      </div>
    </div>
  );
}
