import type { MissionStatus } from "@overflow/schemas";
import { Pill } from "@/components/shared/status-pill";
import { MISSION_STATUS_STYLE } from "@/lib/missions/status";

export { agentLabel } from "@/components/purchases/shared";
export { Field, formatWhen, Panel } from "@/components/shared/panel";

export const INPUT = "h-9 rounded-lg border border-border bg-surface px-3 text-sm text-text";
export const SELECT = "h-9 rounded-lg border border-border bg-surface px-3 text-sm text-text";
export const TEXTAREA = "min-h-24 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text";
export const LABEL = "flex flex-col gap-1 text-xs text-text-muted";

export function MissionStatusPill({ status, className }: { status: MissionStatus; className?: string }) {
  const s = MISSION_STATUS_STYLE[status];
  return (
    <Pill tone={s.tone} title={s.hint} className={className}>
      {s.label}
    </Pill>
  );
}
