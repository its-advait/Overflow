import type { ExceptionRecord, ReconciliationRun } from "@overflow/schemas";
import type { Tone } from "@/components/shared/status-pill";

// ---------------------------------------------------------------------------
// Reconciliation as the controller reads it (SPEC "Reconciliation"): the chain
// is the bank, the ledger is the books. Rows come straight from a stored run;
// nothing is recomputed from the chain here. bigint only.
// ---------------------------------------------------------------------------

export type ReconRowKind = "treasury" | "escrow" | "event-coverage";

export interface ReconRow {
  kind: ReconRowKind;
  /** The exception subject the service uses for this check ("treasury", "escrow:<purchaseId>", "event:<key>"). */
  subject: string;
  label: string;
  detail?: string | undefined;
  purchaseId?: string | undefined;
  escrowAddress?: string | undefined;
  escrowStatus?: ReconciliationRun["escrows"][number]["status"] | undefined;
  open: boolean;
  /** What the chain says (undefined when the check read no balance, e.g. an unfunded or closed order). */
  chainAtomic?: bigint | undefined;
  /** What the chain implies the books should say (balance minus bond for an escrow). */
  expectedAtomic?: bigint | undefined;
  ledgerAtomic: bigint;
  differenceAtomic: bigint;
  material: boolean;
}

export const RUN_STATUS_STYLE: Record<ReconciliationRun["status"], { label: string; tone: Tone; hint: string }> = {
  ok: { label: "Books match the chain", tone: "success", hint: "Every treasury, escrow and event check agreed at the run's block." },
  differences: { label: "Differences found", tone: "warning", hint: "At least one check disagreed; material ones opened an exception." },
};

export const isMaterial = (differenceAtomic: bigint, materialityAtomic: bigint): boolean =>
  (differenceAtomic < 0n ? -differenceAtomic : differenceAtomic) > materialityAtomic;

/** Treasury row, then every escrow check (open orders first), then event-coverage differences. */
export function reconciliationRows(run: ReconciliationRun): ReconRow[] {
  const treasury: ReconRow = {
    kind: "treasury",
    subject: "treasury",
    label: "USDC treasury",
    detail: `balanceOf(treasury) at block ${run.blockNumber} vs the usdc-treasury account`,
    open: true,
    chainAtomic: BigInt(run.treasuryChainAtomic),
    expectedAtomic: BigInt(run.treasuryChainAtomic),
    ledgerAtomic: BigInt(run.treasuryLedgerAtomic),
    differenceAtomic: BigInt(run.treasuryDifferenceAtomic),
    material: isMaterial(BigInt(run.treasuryDifferenceAtomic), BigInt(run.materialityAtomic)),
  };
  const escrows: ReconRow[] = [...run.escrows]
    .sort((a, b) => Number(b.open) - Number(a.open) || a.purchaseId.localeCompare(b.purchaseId))
    .map((e) => ({
      kind: "escrow",
      subject: `escrow:${e.purchaseId}`,
      label: `Escrow for ${e.purchaseId}`,
      detail: e.open
        ? e.chainAtomic !== undefined
          ? `balanceOf(escrow) minus the seller's bond vs the order's escrow-deposit line`
          : "unfunded order: its escrow-deposit line must be zero"
        : `closed (${e.status}): its escrow-deposit line must net to zero`,
      purchaseId: e.purchaseId,
      escrowAddress: e.escrowAddress,
      escrowStatus: e.status,
      open: e.open,
      chainAtomic: e.chainAtomic === undefined ? undefined : BigInt(e.chainAtomic),
      expectedAtomic: BigInt(e.expectedAtomic),
      ledgerAtomic: BigInt(e.ledgerAtomic),
      differenceAtomic: BigInt(e.differenceAtomic),
      material: e.material,
    }));
  const coverage: ReconRow[] = run.differences
    .filter((d) => d.kind === "event-coverage")
    .map((d) => ({
      kind: "event-coverage",
      subject: d.subject,
      label: d.eventKey ? `Event ${d.eventKey}` : d.subject,
      detail: d.reason,
      purchaseId: d.purchaseId,
      open: true,
      ledgerAtomic: d.ledgerAtomic === undefined ? 0n : BigInt(d.ledgerAtomic),
      differenceAtomic: BigInt(d.differenceAtomic),
      material: d.material,
    }));
  return [treasury, ...escrows, ...coverage];
}

export const materialRows = (rows: readonly ReconRow[]): ReconRow[] => rows.filter((r) => r.material);

/** The open exception a row's difference opened (matched by subject), if any. */
export function exceptionFor(row: ReconRow, exceptions: readonly ExceptionRecord[]): ExceptionRecord | undefined {
  return exceptions.find((e) => e.type === "RECONCILIATION_DIFF" && e.subject === row.subject && e.status === "open");
}
