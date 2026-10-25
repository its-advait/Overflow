import type { ReactNode } from "react";
import type { EscrowStatus, PurchaseStatus } from "@overflow/schemas";
import { cn } from "@/lib/utils";

export type Tone = "blue" | "cyan" | "violet" | "success" | "warning" | "danger" | "muted";

const TONES: Record<Tone, string> = {
  blue: "border-blue/30 bg-blue/10 text-blue",
  cyan: "border-cyan/30 bg-cyan/10 text-cyan",
  violet: "border-violet/30 bg-violet/10 text-violet",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-danger/30 bg-danger/10 text-danger",
  muted: "border-border bg-surface-raised text-text-muted",
};

/**
 * One entry per PurchaseStatus (exhaustive: adding a status fails typecheck here).
 * The three financial events stay visually distinct: authorization (blue),
 * escrow funding (cyan), final settlement (success / warning / danger).
 */
export const PURCHASE_STATUS_STYLE: Record<PurchaseStatus, { label: string; tone: Tone; hint: string }> = {
  PROPOSED: { label: "Proposed", tone: "muted", hint: "Oracle and Fusion proposal. No money moved." },
  RESERVED: { label: "Reserved", tone: "blue", hint: "Agent signed; allowance reserved. Nothing paid yet." },
  PAYMENT_PENDING: { label: "Payment pending", tone: "blue", hint: "Submitted to the facilitator; waiting for the chain." },
  ESCROW_FUNDED: { label: "Escrow funded", tone: "cyan", hint: "OrderFunded confirmed. Seller must reveal." },
  DELIVERY_PENDING: { label: "Delivery pending", tone: "cyan", hint: "Key revealed; buyer verifying delivery." },
  SETTLED: { label: "Settled", tone: "success", hint: "PaidOut confirmed; seller paid." },
  REFUNDED: { label: "Refunded", tone: "warning", hint: "Refund confirmed; USDC back in the treasury." },
  REJECTED: { label: "Rejected", tone: "danger", hint: "Treasury policy revert; no funds moved." },
  PAYMENT_UNKNOWN: {
    label: "Payment unknown",
    tone: "warning",
    hint: "Broadcast with no receipt. Reconcile; never retry with a new nonce.",
  },
  FAILED_BEFORE_FUNDING: { label: "Failed", tone: "danger", hint: "Failed before any USDC moved." },
  RELEASED: { label: "Released", tone: "muted", hint: "Reservation expired unused; allowance restored." },
};

export const ESCROW_STATUS_STYLE: Record<EscrowStatus, { label: string; tone: Tone }> = {
  Created: { label: "Created", tone: "muted" },
  Funded: { label: "Funded", tone: "cyan" },
  Revealed: { label: "Revealed", tone: "blue" },
  Settled: { label: "Settled", tone: "success" },
  Refunded: { label: "Refunded", tone: "warning" },
};

export function Pill({
  tone,
  children,
  title,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusPill({ status, className }: { status: PurchaseStatus; className?: string }) {
  const s = PURCHASE_STATUS_STYLE[status];
  return (
    <Pill tone={s.tone} title={s.hint} className={className}>
      {s.label}
    </Pill>
  );
}

export function EscrowStatusPill({ status, className }: { status: EscrowStatus; className?: string }) {
  const s = ESCROW_STATUS_STYLE[status];
  return (
    <Pill tone={s.tone} className={className}>
      {s.label}
    </Pill>
  );
}
