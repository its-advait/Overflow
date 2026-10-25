// ---------------------------------------------------------------------------
// docs/SPEC.md "Planted-error set with answer key", verbatim. These rows are
// FIXED: a case that disagrees with its row fails; the row is never edited to
// make a case pass. answer-key.test.ts re-reads the table from docs/SPEC.md and
// fails if anything here drifts from it.
// ---------------------------------------------------------------------------

export interface AnswerKeyRow {
  id: number;
  plantedError: string;
  expected: string;
  caughtBy: string;
}

export const ANSWER_KEY: readonly AnswerKeyRow[] = [
  { id: 1, plantedError: "A listing tells the agent to pay an attacker", expected: "`PayeeNotAllowed(0)`", caughtBy: "Treasury" },
  { id: 2, plantedError: "The same signature sent straight to USDC", expected: "`FiatTokenV2: invalid signature`", caughtBy: "ERC-1271 gate" },
  { id: 3, plantedError: "A search-only agent pays a scraping seller", expected: "`PayeeNotAllowed(n)`", caughtBy: "Node allowlist" },
  { id: 4, plantedError: "A payment above the per-call limit", expected: "`OverPerCall(n)`", caughtBy: "Treasury" },
  { id: 5, plantedError: "Sub-agents together exceed the parent's cap", expected: "`OverBudget(parent)`", caughtBy: "Tree walk" },
  { id: 6, plantedError: "A payment after expiry", expected: "`Expired(n)`", caughtBy: "Treasury" },
  { id: 7, plantedError: "The orchestrator is paused and a child pays", expected: "`Paused(root)`", caughtBy: "Tree walk" },
  { id: 8, plantedError: "The seller never reveals the key", expected: "Timeout refund", caughtBy: "Escrow" },
  { id: 9, plantedError: "The seller swaps one chunk after sampling", expected: "Mismatch proof, refund plus bond", caughtBy: "Escrow" },
  { id: 10, plantedError: "A record is signed by the wrong source key", expected: "Promise proof, refund", caughtBy: "Escrow" },
  { id: 11, plantedError: "The buyer complains about a correct file", expected: "Complaint reverts; seller paid", caughtBy: "Escrow" },
  { id: 12, plantedError: "Two agents request the same compatible data", expected: "One purchase, two allocations", caughtBy: "Fusion" },
  { id: 13, plantedError: "Same topic, wrong region", expected: "Two separate decisions", caughtBy: "Fusion" },
  { id: 14, plantedError: "A single-user license", expected: "No merge", caughtBy: "Fusion" },
  { id: 15, plantedError: "A dataset missing required dates", expected: "Rejected before purchase", caughtBy: "Oracle" },
  { id: 16, plantedError: "Two concurrent buys of one order", expected: "One funded order", caughtBy: "Idempotency key" },
  { id: 17, plantedError: "An RPC timeout after broadcast", expected: "Reconciled; no second payment", caughtBy: "State machine" },
  { id: 18, plantedError: "A flagged seller opens a new order", expected: "`PayeeFlagged`", caughtBy: "Treasury and factory" },
  { id: 19, plantedError: "The seller's quote differs from the order", expected: "Not signed", caughtBy: "Payment client" },
  { id: 20, plantedError: "The ledger is off by a planted 0.50 USDC", expected: "Exception opened for the controller", caughtBy: "Reconciliation" },
];

export function answerKey(id: number): AnswerKeyRow {
  const row = ANSWER_KEY.find((r) => r.id === id);
  if (!row) throw new Error(`no answer-key row ${id}`);
  return row;
}

/** Parses the planted-error table out of docs/SPEC.md (used by the drift test). */
export function parseSpecAnswerKey(spec: string): AnswerKeyRow[] {
  const start = spec.indexOf("### Planted-error set with answer key");
  if (start < 0) throw new Error("docs/SPEC.md has no 'Planted-error set with answer key' section");
  const rows: AnswerKeyRow[] = [];
  for (const line of spec.slice(start).split("\n").slice(1)) {
    if (line.startsWith("### ")) break;
    const m = /^\|\s*(\d+)\s*\|(.*)\|(.*)\|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    rows.push({ id: Number(m[1]), plantedError: m[2]!.trim(), expected: m[3]!.trim(), caughtBy: m[4]!.trim() });
  }
  return rows;
}
