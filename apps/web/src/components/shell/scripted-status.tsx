"use client";

import { api } from "@/lib/api";
import { useApiQuery } from "@/lib/use-api";
import { ScriptedBadge } from "./scripted-badge";

/**
 * Shows the SCRIPTED badge only when the service reports DEMO_SCRIPTED=replay on GET /: the model's answers
 * come from a recording while every transaction is live. While loading, on error, or in any other mode the
 * slot is empty; a badge is never shown from the web's own environment.
 */
export function ScriptedStatus() {
  const status = useApiQuery(() => api.status(), []);
  const scripted = status.data?.scripted;
  if (!scripted || scripted.mode !== "replay") return null;
  const name = scripted.recording?.name ?? "unknown";
  const model = scripted.recording?.model ?? "unknown model";
  return <ScriptedBadge title={`Model answers replay from recording "${name}" (recorded with ${model}). Every transaction on screen is live on Base Sepolia.`} />;
}
