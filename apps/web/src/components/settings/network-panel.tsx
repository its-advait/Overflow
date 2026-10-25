import type { NetworkInfo } from "@overflow/schemas";
import { Address, Mono } from "@/components/shared/address";
import { CopyButton } from "@/components/shared/copy-button";
import { Money } from "@/components/shared/money";
import { Pill } from "@/components/shared/status-pill";
import { Field, formatWhen, Panel } from "@/components/missions/shared";

/** Network and contract facts as the service read them from the chain at one block (GET /api/settings/network). */
export function NetworkPanel({ info }: { info: NetworkInfo }) {
  return (
    <Panel
      title="Network and contracts"
      aside={
        <Pill tone={info.network === "local Anvil fork" ? "warning" : "cyan"} title={`RPC ${info.rpc}`}>
          {info.network} · chain {info.chainId}
        </Pill>
      }
    >
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="network">
        <Field label="Treasury">
          <Address value={info.treasury} full /> <CopyButton value={info.treasury} />
        </Field>
        <Field label="Escrow factory">{info.escrowFactory ? <Address value={info.escrowFactory} full /> : <span className="text-text-muted">none set</span>}</Field>
        <Field label="Owner (controller)">
          <Address value={info.owner} full /> <CopyButton value={info.owner} />
        </Field>
        <Field label="Token">
          <Address value={info.token.address} full /> <span className="text-xs text-text-muted">{info.token.name} v{info.token.version}, {info.token.decimals} decimals</span>
        </Field>
        <Field label="USDC domain separator">
          <Mono value={info.token.domainSeparator} className="text-xs" />
        </Field>
        <Field label="Relayer (gas only, never USDC)">
          <Address value={info.relayer} full />
        </Field>
        <Field label="Floor">
          <Money atomic={info.floorAtomic} size="sm" />
        </Field>
        <Field label="Reservation window">{info.reservationWindowSeconds} s</Field>
        <Field label="Reserved total">
          <Money atomic={info.reservedTotalAtomic} size="sm" />
        </Field>
        <Field label="Nodes">{info.nodeCount}</Field>
        <Field label="Read at block">
          {info.blockNumber} · {formatWhen(info.readAt)}
        </Field>
        <Field label="Deployed">{info.deployBlock ? `block ${info.deployBlock}${info.deployedAt ? ` · ${formatWhen(info.deployedAt)}` : ""}` : "not recorded"}</Field>
      </dl>
    </Panel>
  );
}
