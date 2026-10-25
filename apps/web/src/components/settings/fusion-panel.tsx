"use client";

import Link from "next/link";
import { useState } from "react";
import type { MissionRecord } from "@overflow/schemas";
import { ErrorState } from "@/components/shared/error-state";
import { Pill } from "@/components/shared/status-pill";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import type { ProposeResponse } from "@/lib/api/contracts";
import { fusionDecisions, parseFusionDecision } from "@/lib/settings";
import { useApiQuery } from "@/lib/use-api";
import { formatWhen, Panel, SELECT } from "@/components/missions/shared";

/**
 * The Fusion check: pick a confirmed or active mission, press Propose, read back the `fusion.decision` rows the
 * service wrote for it. Propose answers 501 in a service without order terms (by design) after recording the
 * decision; the panel says so and still shows the recorded rows. Nothing here is a purchase.
 */
export function FusionPanel({ missions }: { missions: readonly MissionRecord[] }) {
  const eligible = missions.filter((m) => m.status === "confirmed" || m.status === "active");
  const [missionId, setMissionId] = useState(eligible[0]?.id ?? "");
  const selected = eligible.find((m) => m.id === missionId) ?? eligible[0];
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [response, setResponse] = useState<ProposeResponse | null>(null);
  const decisions = useApiQuery(() => (selected ? api.listActivity({ missionId: selected.id, kind: "fusion.decision", limit: 50 }) : Promise.resolve({ events: [] })), [selected?.id, tick]);
  const rows = fusionDecisions(decisions.data?.events ?? []);

  const propose = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setResponse(null);
    try {
      setResponse(await api.proposePurchases(selected.id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setTick((n) => n + 1);
    }
  };
  const notWired = error instanceof ApiError && error.status === 501;

  return (
    <Panel
      title="Fusion check"
      aside={
        <Button size="sm" onClick={() => void propose()} disabled={!selected || busy} title={selected ? "Oracle recommends per open request, Fusion judges the merge; the decision is recorded" : "Needs a confirmed or active mission with open requests"}>
          {busy ? "Proposing…" : "Propose purchases"}
        </Button>
      }
    >
      <p className="mb-3 text-xs text-text-muted">After a license or price edit, propose again on a confirmed mission and compare the newest decision with the one before. Each row is the service&apos;s own `fusion.decision` record.</p>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Mission
        <select className={SELECT} value={selected?.id ?? ""} onChange={(e) => setMissionId(e.target.value)} disabled={eligible.length === 0}>
          {eligible.length === 0 ? <option value="">no confirmed or active mission</option> : null}
          {eligible.map((m) => (
            <option key={m.id} value={m.id}>
              {m.goal.slice(0, 70)}
              {m.goal.length > 70 ? "…" : ""} · {m.status}
            </option>
          ))}
        </select>
      </label>
      {selected ? (
        <p className="mt-1 text-[11px] text-text-muted">
          <Link className="text-blue underline underline-offset-4" href={`/missions/${encodeURIComponent(selected.id)}`}>
            open the mission
          </Link>
        </p>
      ) : null}
      {response ? (
        <div className="mt-3 rounded-lg border border-border bg-surface-raised/60 p-3 text-xs" data-testid="propose-result">
          <span className="font-medium text-text">Service answered:</span> {response.purchases.length} purchase(s) proposed (PROPOSED rows, nothing paid);{" "}
          {response.merges.map((m) => `${m.merge ? "merge" : "no merge"}${m.listingId ? ` on ${m.listingId}` : ""}${m.failingRules.length ? ` (${m.failingRules.join(", ")})` : ""}`).join("; ") || "no merge candidates"}
        </div>
      ) : null}
      {error ? (
        notWired ? (
          <div className="mt-3 rounded-lg border border-border bg-surface-raised/60 p-3 text-xs text-text-muted" data-testid="propose-not-wired">
            <span className="font-medium text-text">No order prepared:</span> this service has no order terms wired ({(error as ApiError).message}). The list below is re-read from the service and shows what it recorded for this attempt, if anything.
          </div>
        ) : (
          <ErrorState error={error} title="Propose refused" className="mt-3" />
        )
      ) : null}
      <h4 className="mt-4 text-xs font-medium uppercase tracking-wider text-text-muted">Recorded Fusion decisions, newest first</h4>
      {decisions.error ? <ErrorState error={decisions.error} title="Could not read the mission's activity" className="mt-2" /> : null}
      {rows.length === 0 && !decisions.loading ? <p className="mt-2 text-xs text-text-muted">None yet for this mission.</p> : null}
      <ul className="mt-2 flex flex-col divide-y divide-border" data-testid="fusion-decisions">
        {rows.map((e) => {
          const parsed = parseFusionDecision(e.message);
          return (
            <li key={e.id} className="flex flex-col gap-1 py-2 text-xs" data-verdict={parsed.verdict} data-listing={parsed.listingId ?? ""}>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={parsed.verdict === "merge" ? "success" : parsed.verdict === "no-merge" ? "warning" : "muted"}>{parsed.verdict === "merge" ? "Merge" : parsed.verdict === "no-merge" ? "No merge" : "Decision"}</Pill>
                {parsed.listingId ? <span className="font-mono text-text">{parsed.listingId}</span> : <span className="text-text-muted">no listing</span>}
                {parsed.failingRules.map((r) => (
                  <Pill key={r} tone="danger">
                    {r}
                  </Pill>
                ))}
                <span className="text-text-muted">{formatWhen(e.at)}</span>
              </div>
              <p className="text-text-muted">{e.message}</p>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
