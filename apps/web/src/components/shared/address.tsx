import { ExternalLink } from "lucide-react";
import { explorerUrl } from "@overflow/schemas";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

function truncate(value: string, chars: number): string {
  if (value.length <= chars * 2 + 2) return value;
  return `${value.slice(0, chars + 2)}…${value.slice(-chars)}`;
}

function HexRef({
  value,
  kind,
  chars,
  full,
  className,
}: {
  value: string;
  kind: "address" | "tx";
  chars: number;
  full: boolean;
  className?: string;
}) {
  const href = explorerUrl(kind, value);
  return (
    <span className={cn("inline-flex items-center gap-1 align-middle", className)}>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        title={`${value} · open on Basescan`}
        className="group inline-flex items-center gap-1 font-mono text-[13px] text-text hover:text-cyan"
      >
        <span className={full ? "break-all" : ""}>{full ? value : truncate(value, chars)}</span>
        <ExternalLink
          className="size-3 text-text-muted opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      </a>
      <CopyButton value={value} label={kind === "tx" ? "Copy transaction hash" : "Copy address"} />
    </span>
  );
}

/** Monospace, middle-truncated, copy button and a Basescan address link. */
export function Address({
  value,
  chars = 4,
  full = false,
  className,
}: {
  value: string;
  chars?: number;
  full?: boolean;
  className?: string;
}) {
  return <HexRef value={value} kind="address" chars={chars} full={full} className={className} />;
}

/** Same as Address but links to the transaction page. */
export function TxHash({
  value,
  chars = 6,
  full = false,
  className,
}: {
  value: string;
  chars?: number;
  full?: boolean;
  className?: string;
}) {
  return <HexRef value={value} kind="tx" chars={chars} full={full} className={className} />;
}

/** Ids and digests that have no explorer page: monospace plus copy. */
export function Mono({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 align-middle font-mono text-[13px] text-text", className)}>
      <span className="break-all">{value}</span>
      <CopyButton value={value} />
    </span>
  );
}
