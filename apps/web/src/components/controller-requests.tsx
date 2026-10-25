"use client";

import type { ControllerRequest } from "@overflow/schemas";
import { useEffect, useState } from "react";
import { phaseOf, type Phase } from "@/lib/controller-phase";

/**
 * Controller requests: owner actions agents proposed, which the controller approves in Coinbase Wallet through
 * Wallet MCP. Every row's state comes from the service's database; DONE appears only when the indexer stored the
 * treasury event (status === "done" with a txHash). Nothing here sends or signs anything.
 */

const BASESCAN_TX = "https://sepolia.basescan.org/tx/";
const POLL_MS = 5000;

type ListResponse = { requests: ControllerRequest[]; treasury: string | null };

export { phaseOf };

const BADGE: Record<Phase, { label: string; className: string }> = {
  pending: { label: "pending", className: "border-border bg-muted text-muted-foreground" },
  "awaiting-approval": { label: "awaiting approval", className: "border-amber-300 bg-amber-50 text-amber-900" },
  done: { label: "DONE (indexed event)", className: "border-emerald-300 bg-emerald-50 text-emerald-900" },
  rejected: { label: "rejected", className: "border-rose-300 bg-rose-50 text-rose-900" },
};

function describe(r: ControllerRequest): string {
  const a = r.action;
  switch (a.kind) {
    case "set-allow":
      return `${a.allowed ? "Allow" : "Remove"} payee ${a.payee}`;
    case "raise-cap":
      return `Raise node ${a.nodeId} cap to ${a.newCapAtomic} atomic USDC`;
    case "pause":
      return `Pause node ${a.nodeId}`;
    case "unpause":
      return `Unpause node ${a.nodeId}`;
    case "set-floor":
      return `Set floor to ${a.newFloorAtomic} atomic USDC`;
    case "withdraw":
      return `Withdraw ${a.amountAtomic} atomic USDC to ${a.to}`;
    case "set-escrow-factory":
      return `Set escrow factory ${a.factory}`;
  }
}

export function ControllerRequests({ serviceUrl }: { serviceUrl: string }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${serviceUrl}/api/controller-requests?status=all`, { cache: "no-store" });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = (await res.json()) as ListResponse;
        if (cancelled) return;
        setData(body);
        setError(null);
        setFetchedAt(new Date().toISOString());
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [serviceUrl]);

  return (
    <section className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Agents propose; the controller approves each call in Coinbase Wallet (Wallet MCP <code>send_calls</code>). A
        request shows <strong>DONE</strong> only when the indexer stored the treasury event; the approval link alone
        proves nothing.
      </p>
      <p className="text-xs text-muted-foreground">
        Service: <code>{serviceUrl}</code>
        {data?.treasury ? (
          <>
            {" "}· treasury <code>{data.treasury}</code>
          </>
        ) : null}
        {fetchedAt ? <> · refreshed {fetchedAt}</> : null}
        {error ? <span className="text-rose-700"> · fetch failed: {error}</span> : null}
      </p>
      {data && data.requests.length === 0 ? <p className="text-sm">No controller requests yet.</p> : null}
      {data && data.requests.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {[...data.requests].reverse().map((r) => {
            const phase = phaseOf(r);
            const badge = BADGE[phase];
            return (
              <li key={r.id} className="rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{describe(r)}</span>
                  <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{r.summary}</p>
                <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">requested by</dt>
                  <dd>
                    {r.requestedBy}: {r.reason}
                  </dd>
                  <dt className="text-muted-foreground">target / value</dt>
                  <dd className="font-mono break-all">
                    {r.target} / {r.value} wei
                  </dd>
                  {r.submission ? (
                    <>
                      <dt className="text-muted-foreground">approval</dt>
                      <dd className="break-all">
                        <a className="text-primary underline underline-offset-4" href={r.submission.approvalUrl} target="_blank" rel="noreferrer">
                          open in Coinbase Wallet
                        </a>{" "}
                        · Wallet MCP request <code>{r.submission.requestId}</code> · submitted {r.submission.submittedAt} by {r.submission.submittedBy}
                      </dd>
                    </>
                  ) : null}
                  {r.txHash ? (
                    <>
                      <dt className="text-muted-foreground">confirmed in</dt>
                      <dd className="break-all">
                        <a className="text-primary underline underline-offset-4" href={`${BASESCAN_TX}${r.txHash}`} target="_blank" rel="noreferrer">
                          {r.txHash}
                        </a>
                      </dd>
                    </>
                  ) : null}
                </dl>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
