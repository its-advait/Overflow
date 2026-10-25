"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { EscrowStatus, RecourseSellerView, ResourceRecord, RunOrderResponse, SellerBehaviour } from "@overflow/schemas";
import { Address, TxHash } from "@/components/shared/address";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { MoneyActionPreview } from "@/components/shared/money-action-preview";
import { SimulatedBadge } from "@/components/shared/simulated-badge";
import { EscrowStatusPill, Pill, StatusPill } from "@/components/shared/status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import { useApiQuery } from "@/lib/use-api";
import { BEHAVIOUR_HINT, expectedOutcome, orderedTxs, orderLink } from "@/lib/settings";
import { Panel, SELECT } from "@/components/missions/shared";

const BEHAVIOURS: SellerBehaviour[] = ["honest", "ghost", "swap"];
/** How often the result card re-reads the order's indexed status while it is still open. */
const ESCROW_POLL_MS = 3_000;
const TERMINAL: EscrowStatus[] = ["Settled", "Refunded"];

/**
 * SIMULATED sellers: what each plays on its next order, and "run one order now". Every row is the service's
 * answer; the behaviour select re-reads the row the PUT returned. The order card shows the runner's own steps
 * and tx hashes, then the escrow and purchase status as the indexer reports them: SETTLED or REFUNDED appear
 * only once the chain event is indexed.
 */
export function SellersPanel({ sellers, listings, treasury, onChanged }: { sellers: readonly RecourseSellerView[]; listings: readonly ResourceRecord[]; treasury: string | null; onChanged: () => void }) {
  return (
    <Panel title={<span className="inline-flex items-center gap-2">Sellers <SimulatedBadge what="sellers" /></span>}>
      <p className="mb-3 text-xs text-text-muted">
        The three SIMULATED sellers of the local Anvil recourse run. A behaviour applies to that seller&apos;s next order and lives in the service&apos;s memory (a restart returns to honest, ghost, swap). A seller the factory has flagged keeps its flag whatever is chosen here.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Seller</TableHead>
            <TableHead>Next order</TableHead>
            <TableHead>What that means</TableHead>
            <TableHead>Chain record</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sellers.map((s) => (
            <SellerRow key={s.address} seller={s} onChanged={onChanged} />
          ))}
        </TableBody>
      </Table>
      <RunOrder sellers={sellers} listings={listings} treasury={treasury} onChanged={onChanged} />
    </Panel>
  );
}

function SellerRow({ seller, onChanged }: { seller: RecourseSellerView; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const change = async (behaviour: SellerBehaviour) => {
    setSaving(true);
    setError(null);
    try {
      await api.setSellerBehaviour(seller.address, behaviour);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <TableRow data-testid="seller-row" data-seller={seller.address} data-behaviour={seller.behaviour}>
      <TableCell className="font-mono text-xs text-text-muted">{seller.index}</TableCell>
      <TableCell>
        <Address value={seller.address} />
      </TableCell>
      <TableCell>
        <select className={SELECT} value={seller.behaviour} disabled={saving} onChange={(e) => void change(e.target.value as SellerBehaviour)} aria-label={`behaviour of seller ${seller.index}`}>
          {BEHAVIOURS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        {saving ? <span className="ml-2 text-xs text-text-muted">Saving…</span> : null}
        {error ? <ErrorState error={error} title="Edit refused" className="mt-2" /> : null}
      </TableCell>
      <TableCell className="max-w-xs text-xs text-text-muted">{BEHAVIOUR_HINT[seller.behaviour]}</TableCell>
      <TableCell>
        {seller.flagged ? (
          <Pill tone="danger" title="The escrow factory recorded a proven cheat (CheatRecorded): create() reverts SellerFlagged and the treasury refuses the payee.">
            flagged
          </Pill>
        ) : (
          <Pill tone="muted">no cheat on record</Pill>
        )}
      </TableCell>
    </TableRow>
  );
}

function RunOrder({ sellers, listings, treasury, onChanged }: { sellers: readonly RecourseSellerView[]; listings: readonly ResourceRecord[]; treasury: string | null; onChanged: () => void }) {
  const simulated = listings.filter((l) => l.simulated);
  const [sellerAddress, setSellerAddress] = useState(sellers[0]?.address ?? "");
  const [listingId, setListingId] = useState(simulated[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<RunOrderResponse | null>(null);
  const seller = sellers.find((s) => s.address === sellerAddress) ?? sellers[0];
  const listing = simulated.find((l) => l.id === listingId) ?? simulated[0];

  const run = async () => {
    if (!seller || !listing) return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.runOrder({ sellerAddress: seller.address, listingId: listing.id });
      setResult(r);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-3" data-testid="run-order">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Seller
          <select className={SELECT} value={seller?.address ?? ""} onChange={(e) => setSellerAddress(e.target.value)} disabled={pending}>
            {sellers.map((s) => (
              <option key={s.address} value={s.address}>
                #{s.index} {s.address.slice(0, 10)}… · {s.behaviour}
                {s.flagged ? " · flagged" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Listing (SIMULATED)
          <select className={SELECT} value={listing?.id ?? ""} onChange={(e) => setListingId(e.target.value)} disabled={pending}>
            {simulated.map((l) => (
              <option key={l.id} value={l.id}>
                {l.id}
              </option>
            ))}
          </select>
        </label>
      </div>
      <MoneyActionPreview
        title="Run one SIMULATED order now"
        payer={treasury ? { label: "treasury, root node 1 signs", address: treasury } : { label: "treasury, root node 1 signs" }}
        amountAtomic={listing ? listing.priceAtomic : null}
        destination={seller ? { label: `a new escrow for seller #${seller.index} (${seller.behaviour}); the factory predicts its address`, address: seller.address } : null}
        expectedOutcome={seller ? (seller.flagged ? `The factory refuses create() with SellerFlagged(${seller.address.slice(0, 10)}…); the purchase closes REJECTED and nothing is paid.` : expectedOutcome(seller.behaviour)) : null}
        confirmLabel="Run order on Anvil"
        onConfirm={() => void run()}
        pending={pending}
        footnote="Local Anvil fork only. The runner pays through settle() like any agent; the statuses below come from the indexer."
      />
      {pending ? <p className="text-xs text-text-muted">Running on Anvil: create, bond, settle(), markFunded, then the seller&apos;s move…</p> : null}
      {error ? <ErrorState error={error} title={error instanceof ApiError && error.status === 501 ? "SIMULATED orders need the local Anvil fork" : "The service refused the order"} /> : null}
      {result ? <OrderResult result={result} /> : null}
    </div>
  );
}

function OrderResult({ result }: { result: RunOrderResponse }) {
  const { order } = result;
  const [tick, setTick] = useState(0);
  const escrow = useApiQuery(() => api.getEscrow(order.purchaseId), [order.purchaseId, tick]);
  const status = escrow.data?.escrow.status;
  useEffect(() => {
    if (status && TERMINAL.includes(status)) return;
    const t = setTimeout(() => setTick((n) => n + 1), ESCROW_POLL_MS);
    return () => clearTimeout(t);
  }, [status, tick]);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised/60 p-3 text-sm" data-testid="order-result" data-purchase={order.purchaseId}>
      <div className="flex flex-wrap items-center gap-2">
        <SimulatedBadge what="order" />
        <span className="font-medium text-text">
          Runner finished: last step <span className="font-mono">{order.lastStep}</span>
        </span>
        <Pill tone="muted">{order.behaviour}</Pill>
        <Money atomic={order.amountAtomic} size="sm" /> <span className="text-xs text-text-muted">+ bond</span> <Money atomic={order.bondAtomic} size="sm" />
      </div>
      <p className="text-xs text-text-muted">{result.note}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {orderedTxs(order.txs).map((t) => (
          <li key={t.label} className="inline-flex items-center gap-1">
            <span className="text-text-muted">{t.label}</span> <TxHash value={t.hash} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-text-muted">Indexer:</span>
        {escrow.data ? (
          <>
            <EscrowStatusPill status={escrow.data.escrow.status} />
            <StatusPill status={escrow.data.purchase.status} />
          </>
        ) : escrow.error ? (
          <span className="text-danger">could not read the escrow yet</span>
        ) : (
          <span className="text-text-muted">reading…</span>
        )}
        {status && !TERMINAL.includes(status) ? <span className="text-text-muted">(waiting for the chain event)</span> : null}
        <Link className="text-blue underline underline-offset-4" href={orderLink(order)}>
          open the escrow page
        </Link>
        <span className="text-text-muted">
          escrow <Address value={order.escrow} />
        </span>
      </div>
    </div>
  );
}
