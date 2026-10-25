"use client";

import type { ActivityEvent } from "@overflow/schemas";
import { Address } from "@/components/shared/address";
import { Money } from "@/components/shared/money";
import { Pill, type Tone } from "@/components/shared/status-pill";
import type { Counterparty, RefusalStage } from "@/lib/activity";

/** Amount or a dash: the dash means the service wrote no amount for this event, never zero. */
export function AmountCell({ atomic }: { atomic: string | undefined }) {
  return atomic ? <Money atomic={atomic} size="sm" /> : <span className="text-text-muted">—</span>;
}

export function CounterpartyCell({ value }: { value: Counterparty | undefined }) {
  if (!value) return <span className="text-text-muted">—</span>;
  if (value.kind === "address") return <Address value={value.value} chars={4} />;
  if (value.kind === "seller")
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className="max-w-48 truncate text-xs text-text" title={value.label}>
          {value.label}
        </span>
        <Address value={value.value} chars={4} />
      </span>
    );
  let shown = value.value;
  try {
    const u = new URL(value.value);
    shown = `${u.host}${u.pathname}`;
  } catch {
    // keep the raw text
  }
  return (
    <span className="max-w-56 truncate font-mono text-[12px] text-text" title={value.value}>
      {shown}
    </span>
  );
}

const STAGE_TONE: Record<RefusalStage, Tone> = {
  "reverted onchain": "danger",
  "rejected by USDC": "danger",
  "refused in simulation": "warning",
  "refused before signing": "muted",
};

const STAGE_HINT: Record<RefusalStage, string> = {
  "reverted onchain": "The settle() transaction was broadcast and reverted; the revert is on the chain.",
  "rejected by USDC": "The signature was sent straight to USDC, which asked the treasury (ERC-1271) and refused.",
  "refused in simulation": "The facilitator simulated settle(), saw the revert and never broadcast.",
  "refused before signing": "The agent's payment client refused to sign; nothing reached the facilitator.",
};

export function StagePill({ stage }: { stage: RefusalStage }) {
  return (
    <Pill tone={STAGE_TONE[stage]} title={STAGE_HINT[stage]}>
      {stage}
    </Pill>
  );
}

export function stageHint(stage: RefusalStage): string {
  return STAGE_HINT[stage];
}

/** Rows and cards open the drawer by click or keyboard. */
export function openProps(e: ActivityEvent, onOpen: (e: ActivityEvent) => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: () => onOpen(e),
    onKeyDown: (k: React.KeyboardEvent) => {
      if (k.key === "Enter" || k.key === " ") {
        k.preventDefault();
        onOpen(e);
      }
    },
  };
}
