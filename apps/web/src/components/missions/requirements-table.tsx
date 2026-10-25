"use client";

import { useState } from "react";
import { Check, Pencil, Sparkles, X } from "lucide-react";
import type { AgentRecord, MissionRecord, ResourceRequestRecord } from "@overflow/schemas";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { Pill } from "@/components/shared/status-pill";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { FORMATS, GRANULARITIES, LICENSES, fromDraft, groupByAgent, toDraft, type RequirementDraft } from "@/lib/missions/requirements";
import { canConfirm, canPlan, isEditable } from "@/lib/missions/status";
import { INPUT, Panel, SELECT, agentLabel } from "./shared";

/**
 * The requirements the Oracle extracted, per requesting agent, editable while
 * the mission is planning (SPEC "Oracle": the user can edit it before any
 * purchase). Every row shown is a stored request; a saved edit is the row the
 * service returned. Confirm locks the set (mission -> confirmed); nothing is bought.
 */
export function RequirementsTable({ mission, requests, agents, onChanged }: { mission: MissionRecord; requests: readonly ResourceRequestRecord[]; agents: readonly AgentRecord[]; onChanged: () => void }) {
  const { groups, withdrawn } = groupByAgent(requests);
  const [busy, setBusy] = useState<"plan" | "confirm" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  const act = async (what: "plan" | "confirm") => {
    setBusy(what);
    setError(null);
    setNote(null);
    try {
      if (what === "plan") {
        const r = await api.planMission(mission.id);
        setNote(`Service stored ${r.requests.length} requirement(s); mission is ${r.mission.status}.`);
      } else {
        const r = await api.confirmMission(mission.id);
        setNote(`Service recorded mission ${r.mission.status}. Purchases may now be proposed; nothing bought.`);
      }
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const openCount = requests.filter((r) => r.status === "open").length;
  return (
    <Panel
      title={`Requirements · ${requests.length - withdrawn} stored${withdrawn ? `, ${withdrawn} withdrawn by a re-plan` : ""}`}
      aside={
        <>
          <Button size="sm" variant="outline" onClick={() => act("plan")} disabled={busy !== null || !canPlan(mission)} title={canPlan(mission) ? "Oracle extracts requirements from the goal; a re-plan withdraws the open ones." : `Cannot plan while ${mission.status}.`}>
            <Sparkles data-icon="inline-start" />
            {busy === "plan" ? "Extracting…" : requests.length ? "Re-plan" : "Plan requirements"}
          </Button>
          <Button size="sm" onClick={() => act("confirm")} disabled={busy !== null || !canConfirm(mission, requests)} title={canConfirm(mission, requests) ? `Confirm ${openCount} open requirement(s). Nothing is bought.` : "Confirm needs a planning mission with at least one open requirement."}>
            <Check data-icon="inline-start" />
            {busy === "confirm" ? "Confirming…" : "Confirm requirements"}
          </Button>
        </>
      }
    >
      {error ? <ErrorState error={error} title="Service refused" className="mb-3" /> : null}
      {note ? <p className="mb-3 text-xs text-text-muted">{note}</p> : null}
      {groups.length === 0 ? (
        <p className="text-sm text-text-muted">
          {mission.status === "draft" ? "No requirements yet. Plan extracts them from the goal; you review and edit them before anything is bought." : "No stored requirements."}
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.agentId} className="mb-4 last:mb-0">
            <h4 className="mb-2 text-xs font-medium text-text-muted">
              {agentLabel(agents, g.agentId)} · {g.requests.length} request(s)
            </h4>
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Topic</TableHead>
                    <TableHead>Regions</TableHead>
                    <TableHead>Dates</TableHead>
                    <TableHead>Granularity</TableHead>
                    <TableHead>Fields</TableHead>
                    <TableHead>Formats</TableHead>
                    <TableHead>License</TableHead>
                    <TableHead>Fresh ≤</TableHead>
                    <TableHead className="text-right">Max price</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.requests.map((r) => (
                    <RequirementRow key={r.id} mission={mission} request={r} onSaved={onChanged} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ))
      )}
    </Panel>
  );
}

function RequirementRow({ mission, request: r, onSaved }: { mission: MissionRecord; request: ResourceRequestRecord; onSaved: () => void }) {
  const [draft, setDraft] = useState<RequirementDraft | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const editable = isEditable(mission, r);

  const save = async () => {
    if (!draft) return;
    const parsed = fromDraft(draft);
    if (!parsed.ok) {
      setIssues(parsed.issues);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.updateRequest(mission.id, r.id, parsed.request);
      setDraft(null);
      setIssues({});
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  if (!draft) {
    return (
      <TableRow>
        <TableCell className="text-sm text-text">
          {r.topic}
          <div className="font-mono text-[11px] text-text-muted">{r.id}</div>
        </TableCell>
        <TableCell className="text-xs">{r.regions.join(", ")}</TableCell>
        <TableCell className="text-xs tnum">
          {r.dateRange.start} → {r.dateRange.end}
        </TableCell>
        <TableCell className="text-xs">{r.granularity}</TableCell>
        <TableCell className="text-xs">{r.requiredFields.join(", ") || "—"}</TableCell>
        <TableCell className="text-xs">{r.format.join(", ")}</TableCell>
        <TableCell className="text-xs">{r.license}</TableCell>
        <TableCell className="text-xs tnum">{r.freshness.maxAgeDays} d</TableCell>
        <TableCell className="text-right">
          <Money atomic={r.maxPriceAtomic} size="sm" />
        </TableCell>
        <TableCell>
          <Pill tone={r.status === "open" ? "blue" : r.status === "purchased" ? "success" : "muted"}>{r.status}</Pill>
        </TableCell>
        <TableCell>
          <Button size="xs" variant="ghost" disabled={!editable} title={editable ? "Edit this requirement" : "Editable only while the mission is planning and the request is open"} onClick={() => setDraft(toDraft(r))}>
            <Pencil data-icon="inline-start" />
            Edit
          </Button>
        </TableCell>
      </TableRow>
    );
  }

  const field = (key: string) => (issues[key] ? <div className="text-[11px] text-danger">{issues[key]}</div> : null);
  const set = <K extends keyof RequirementDraft>(k: K, v: RequirementDraft[K]) => setDraft({ ...draft, [k]: v });
  return (
    <TableRow>
      <TableCell>
        <input className={`${INPUT} w-44`} value={draft.topic} onChange={(e) => set("topic", e.target.value)} aria-label="Topic" />
        {field("topic")}
      </TableCell>
      <TableCell>
        <input className={`${INPUT} w-28`} value={draft.regions} onChange={(e) => set("regions", e.target.value)} aria-label="Regions, comma separated" />
        {field("regions")}
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          <input className={INPUT} type="date" value={draft.start} onChange={(e) => set("start", e.target.value)} aria-label="Start" />
          <input className={INPUT} type="date" value={draft.end} onChange={(e) => set("end", e.target.value)} aria-label="End" />
        </div>
        {field("dateRange")}
      </TableCell>
      <TableCell>
        <select className={SELECT} value={draft.granularity} onChange={(e) => set("granularity", e.target.value as RequirementDraft["granularity"])} aria-label="Granularity">
          {GRANULARITIES.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
      </TableCell>
      <TableCell>
        <input className={`${INPUT} w-36`} value={draft.requiredFields} onChange={(e) => set("requiredFields", e.target.value)} aria-label="Required fields, comma separated" />
        {field("requiredFields")}
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1 text-xs text-text">
          {FORMATS.map((f) => (
            <label key={f} className="flex items-center gap-1">
              <input type="checkbox" checked={draft.format.includes(f)} onChange={(e) => set("format", e.target.checked ? [...draft.format, f] : draft.format.filter((x) => x !== f))} />
              {f}
            </label>
          ))}
        </div>
        {field("format")}
      </TableCell>
      <TableCell>
        <select className={SELECT} value={draft.license} onChange={(e) => set("license", e.target.value as RequirementDraft["license"])} aria-label="License">
          {LICENSES.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </TableCell>
      <TableCell>
        <input className={`${INPUT} w-16`} inputMode="numeric" value={draft.maxAgeDays} onChange={(e) => set("maxAgeDays", e.target.value)} aria-label="Max age in days" />
        {field("freshness")}
      </TableCell>
      <TableCell>
        <input className={`${INPUT} w-24 text-right`} inputMode="decimal" value={draft.maxPriceUsdc} onChange={(e) => set("maxPriceUsdc", e.target.value)} aria-label="Max price in USDC" />
        {field("maxPriceAtomic")}
      </TableCell>
      <TableCell colSpan={2}>
        <div className="flex flex-col gap-2">
          <div className="flex gap-1">
            <Button size="xs" onClick={save} disabled={saving}>
              <Check data-icon="inline-start" />
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setDraft(null)} disabled={saving}>
              <X data-icon="inline-start" />
              Cancel
            </Button>
          </div>
          {error ? <ErrorState error={error} title="Edit refused" /> : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
