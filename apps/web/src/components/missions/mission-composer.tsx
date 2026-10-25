"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Target } from "lucide-react";
import type { Format } from "@overflow/schemas";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { CreateMissionBody } from "@/lib/api/contracts";
import { parseBudgetInput } from "@/lib/missions/budget";
import { FORMATS } from "@/lib/missions/requirements";
import { useApiQuery } from "@/lib/use-api";
import { INPUT, LABEL, Panel, SELECT, TEXTAREA } from "./shared";

/**
 * MissionComposer (SPEC "UI"): goal, budget in USDC (converted to atomic units on
 * the string, never a float), the data horizon the bought data must cover and
 * the formats the buyer can read. Creating a mission buys nothing: the next step
 * is the Oracle's requirement extraction, which the owner reviews before any purchase.
 */
export function MissionComposer() {
  const router = useRouter();
  const agents = useApiQuery(() => api.listAgents(), []);
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [formats, setFormats] = useState<Format[]>([...FORMATS]);
  const [owner, setOwner] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const parsedBudget = parseBudgetInput(budget);
  const horizonIssue = (start === "") !== (end === "") ? "Give both horizon dates or neither." : start && end && start > end ? "The horizon must start before it ends." : null;
  const ready = goal.trim().length > 0 && goal.length <= 2000 && parsedBudget.ok && formats.length > 0 && !horizonIssue && !pending;

  const submit = async () => {
    if (!ready || !parsedBudget.ok) return;
    setPending(true);
    setError(null);
    const body: CreateMissionBody = {
      goal: goal.trim(),
      budgetAtomic: parsedBudget.atomic,
      allowedFormats: formats,
      ...(start && end ? { horizon: { start, end } } : {}),
      ...(owner ? { ownerAgentId: owner } : {}),
    };
    try {
      const { mission } = await api.createMission(body);
      router.push(`/missions/${encodeURIComponent(mission.id)}`);
    } catch (e) {
      setError(e);
      setPending(false);
    }
  };

  return (
    <Panel title="New mission" aside={<span className="text-xs text-text-muted">Creates a draft. Nothing is bought until requirements are confirmed and a purchase is authorized.</span>}>
      <div className="flex flex-col gap-4">
        <label className={LABEL}>
          Goal
          <textarea className={TEXTAREA} value={goal} maxLength={2000} placeholder="Price Q3 grocery inflation inputs for the FY26 board deck: national index plus two state cuts." onChange={(e) => setGoal(e.target.value)} />
          <span className="text-[11px]">{goal.length} / 2000</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={LABEL}>
            Budget (USDC)
            <input className={INPUT} inputMode="decimal" placeholder="50.00" value={budget} onChange={(e) => setBudget(e.target.value)} />
            {budget.trim() === "" ? (
              <span className="text-[11px]">Sent as integer atomic units (6 decimals).</span>
            ) : parsedBudget.ok ? (
              <span className="text-[11px]">
                <Money atomic={parsedBudget.atomic} size="sm" /> = <span className="font-mono">{parsedBudget.atomic}</span> atomic units
              </span>
            ) : (
              <span className="text-[11px] text-danger">{parsedBudget.error}</span>
            )}
          </label>
          <label className={LABEL}>
            Owner agent (optional)
            <select className={SELECT} value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Orchestrator (default)</option>
              {agents.data?.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.department}
                </option>
              ))}
            </select>
            <span className="text-[11px]">The agent whose requests the Oracle files; its node pays within policy.</span>
          </label>
          <div className={LABEL}>
            Time horizon: data from / to (optional)
            <div className="flex flex-wrap gap-2">
              <input className={INPUT} type="date" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Horizon start" />
              <input className={INPUT} type="date" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="Horizon end" />
            </div>
            <span className={horizonIssue ? "text-[11px] text-danger" : "text-[11px]"}>{horizonIssue ?? "Extracted requirements are clamped inside this range by code, not by the model."}</span>
          </div>
          <div className={LABEL}>
            Allowed resource types (formats the buyer can read)
            <div className="flex flex-wrap gap-3 pt-1">
              {FORMATS.map((f) => (
                <label key={f} className="flex items-center gap-1.5 text-sm text-text">
                  <input type="checkbox" checked={formats.includes(f)} onChange={(e) => setFormats(e.target.checked ? [...formats, f] : formats.filter((x) => x !== f))} />
                  {f}
                </label>
              ))}
            </div>
            <span className={formats.length === 0 ? "text-[11px] text-danger" : "text-[11px]"}>{formats.length === 0 ? "Allow at least one format." : "Requests only carry these formats; the coverage filter enforces them."}</span>
          </div>
        </div>
        {error ? <ErrorState error={error} title="Mission not created" /> : null}
        <div className="flex justify-end">
          <Button onClick={submit} disabled={!ready}>
            <Target data-icon="inline-start" />
            {pending ? "Creating…" : "Create mission"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
