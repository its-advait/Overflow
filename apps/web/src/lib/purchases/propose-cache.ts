import type { ProposeResponse } from "../api/contracts";

// ---------------------------------------------------------------------------
// Session memory for the Purchases pages. Rule-by-rule Oracle and Fusion
// evidence only exists in a propose response (the service stores summaries),
// so the latest response per mission is kept here for list -> detail
// navigation. In memory only: a reload shows the stored summaries instead and
// says so. Idempotency keys live here too, one per purchase, so a retry after
// a network error replays the same authorization instead of minting a new one.
// ---------------------------------------------------------------------------

const proposals = new Map<string, { at: string; response: ProposeResponse }>();
const idempotencyKeys = new Map<string, string>();

export function rememberProposal(missionId: string, response: ProposeResponse): void {
  proposals.set(missionId, { at: new Date().toISOString(), response });
}

export function recallProposal(missionId: string): { at: string; response: ProposeResponse } | undefined {
  return proposals.get(missionId);
}

export function idempotencyKeyFor(purchaseId: string): string {
  let key = idempotencyKeys.get(purchaseId);
  if (!key) {
    key = `web-authorize:${purchaseId}:${crypto.randomUUID()}`;
    idempotencyKeys.set(purchaseId, key);
  }
  return key;
}
