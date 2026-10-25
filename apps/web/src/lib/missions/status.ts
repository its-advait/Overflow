import type { MissionRecord, MissionStatus, ResourceRequestRecord } from "@overflow/schemas";
import type { Tone } from "@/components/shared/status-pill";

// Mission state machine as the service runs it (packages/schemas/src/mission.ts):
// draft -> planning -> confirmed -> active -> complete | cancelled. Exhaustive
// record: a new status fails typecheck here before it renders without a label.

export const MISSION_STATUS_STYLE: Record<MissionStatus, { label: string; tone: Tone; hint: string }> = {
  draft: { label: "Draft", tone: "muted", hint: "Created. No requirements extracted yet; nothing bought." },
  planning: { label: "Planning", tone: "blue", hint: "Oracle extracted requirements; the owner may edit them. Purchases and the run wait for confirmation." },
  confirmed: { label: "Confirmed", tone: "cyan", hint: "Owner confirmed the requirements. Purchases may be proposed; nothing bought yet." },
  active: { label: "Active", tone: "violet", hint: "Agents are running. Every payment still passes the treasury's policy." },
  complete: { label: "Complete", tone: "success", hint: "The mission finished." },
  cancelled: { label: "Cancelled", tone: "warning", hint: "The mission was cancelled." },
};

/** Requirements are editable only while the service accepts a PUT: mission planning, request open. */
export function isEditable(mission: MissionRecord, request: ResourceRequestRecord): boolean {
  return mission.status === "planning" && request.status === "open";
}

export function canPlan(mission: MissionRecord): boolean {
  return mission.status === "draft" || mission.status === "planning" || mission.status === "confirmed";
}

export function canConfirm(mission: MissionRecord, requests: readonly ResourceRequestRecord[]): boolean {
  return mission.status === "planning" && requests.some((r) => r.status === "open");
}

export function canRun(mission: MissionRecord): boolean {
  return mission.status === "confirmed" || mission.status === "active";
}
