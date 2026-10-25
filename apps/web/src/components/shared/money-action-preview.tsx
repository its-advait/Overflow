import type { ReactNode } from "react";
import type { AtomicAmount } from "@overflow/schemas";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Address } from "./address";
import { Money } from "./money";

/**
 * The shared base for every money action (authorize, refund, raise cap, pause).
 * The rule from docs/SPEC.md "UI": payer, amount, destination and expected
 * outcome are shown before anything runs. The confirm button stays disabled
 * until all four are present, and the component itself never calls anything:
 * `onConfirm` hands the decision back to the caller, which hands it to a contract.
 */
export function MoneyActionPreview({
  title,
  payer,
  amountAtomic,
  destination,
  expectedOutcome,
  confirmLabel = "Confirm",
  onConfirm,
  disabled = false,
  pending = false,
  footnote,
  className,
}: {
  title: string;
  /** Who pays: a node, an agent, or the treasury, with its address when known. */
  payer: { label: string; address?: string } | null;
  amountAtomic: AtomicAmount | bigint | null;
  /** Where the USDC goes: an escrow, a seller, or back to the treasury. */
  destination: { label: string; address?: string } | null;
  /** What the caller expects the chain to confirm, in one sentence. */
  expectedOutcome: string | null;
  confirmLabel?: string;
  onConfirm?: () => void;
  disabled?: boolean;
  pending?: boolean;
  footnote?: ReactNode;
  className?: string;
}) {
  const complete = payer !== null && amountAtomic !== null && destination !== null && !!expectedOutcome;
  return (
    <section className={cn("rounded-xl border border-border bg-surface p-5", className)} aria-label={title}>
      <h3 className="text-sm font-medium text-text">{title}</h3>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Payer">{payer ? <Party {...payer} /> : <Missing />}</Field>
        <Field label="Amount">{amountAtomic !== null ? <Money atomic={amountAtomic} size="lg" /> : <Missing />}</Field>
        <Field label="Destination">{destination ? <Party {...destination} /> : <Missing />}</Field>
        <Field label="Expected outcome">
          {expectedOutcome ? <p className="text-sm text-text">{expectedOutcome}</p> : <Missing />}
        </Field>
      </dl>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-xs text-text-muted">
          {footnote ?? "Nothing moves until the treasury's policy checks pass and the chain confirms."}
        </p>
        <Button onClick={onConfirm} disabled={!complete || disabled || pending || !onConfirm}>
          {pending ? "Waiting for chain…" : confirmLabel}
        </Button>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

function Party({ label, address }: { label: string; address?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm text-text">{label}</span>
      {address ? <Address value={address} /> : null}
    </div>
  );
}

function Missing() {
  return <span className="text-sm text-warning">not set</span>;
}
