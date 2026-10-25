import { CHAIN_ID } from "@overflow/schemas";

export function NetworkBadge() {
  return (
    <span
      className="inline-flex h-7 items-center gap-2 rounded-full border border-border bg-surface px-3 text-xs text-text-muted"
      title={`Chain id ${CHAIN_ID}`}
    >
      <span className="size-1.5 rounded-full bg-cyan" aria-hidden />
      Base Sepolia
      <span className="font-mono text-[11px] text-text-muted/70">{CHAIN_ID}</span>
    </span>
  );
}
