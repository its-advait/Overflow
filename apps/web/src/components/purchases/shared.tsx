import type { AgentRecord } from "@overflow/schemas";

export { Field, formatWhen, Panel } from "@/components/shared/panel";

export function agentLabel(agents: readonly AgentRecord[] | undefined, agentId: string): string {
  const a = agents?.find((x) => x.id === agentId);
  return a ? `${a.name} · ${a.department}` : agentId;
}
