"use client";

import { useState } from "react";
import { formatUsdc, toAtomic, type License, type ResourceRecord } from "@overflow/schemas";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { SimulatedBadge } from "@/components/shared/simulated-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { LICENSE_EFFECT } from "@/lib/settings";
import { INPUT, Panel, SELECT } from "@/components/missions/shared";

const LICENSES: License[] = ["company-use", "single-user", "unclear"];

/**
 * SIMULATED listings a judge may reprice or relicense. Each row is the stored resource; a saved edit is the row the
 * service returned (PUT /api/resources/:id), and the next Oracle/Fusion run and the next order read it.
 */
export function ListingsPanel({ listings, onChanged }: { listings: readonly ResourceRecord[]; onChanged: () => void }) {
  const simulated = listings.filter((l) => l.simulated);
  return (
    <Panel title={<span className="inline-flex items-center gap-2">Listings <SimulatedBadge what="sellers and datasets" /></span>}>
      <p className="mb-3 text-xs text-text-muted">Price and license flag per SIMULATED listing. The Oracle filters on the license first, Fusion merges only company-use listings, and a recourse order is priced from this row.</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Listing</TableHead>
            <TableHead>Seller</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>License</TableHead>
            <TableHead>Seats</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {simulated.map((l) => (
            <ListingRow key={l.id} listing={l} onChanged={onChanged} />
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

function ListingRow({ listing, onChanged }: { listing: ResourceRecord; onChanged: () => void }) {
  const [price, setPrice] = useState(formatUsdc(listing.priceAtomic));
  const [license, setLicense] = useState<License>(listing.license);
  const [seats, setSeats] = useState(String(listing.seats));
  const [issue, setIssue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dirty = price !== formatUsdc(listing.priceAtomic) || license !== listing.license || seats !== String(listing.seats);

  const save = async () => {
    setIssue(null);
    setError(null);
    let priceAtomic: string;
    try {
      priceAtomic = toAtomic(price.trim());
    } catch (e) {
      setIssue(e instanceof Error ? e.message : String(e));
      return;
    }
    const seatCount = Number(seats);
    if (!Number.isInteger(seatCount) || seatCount < 1) {
      setIssue("seats must be a whole number of at least 1");
      return;
    }
    setSaving(true);
    try {
      await api.updateResource(listing.id, {
        ...(priceAtomic !== listing.priceAtomic ? { priceAtomic } : {}),
        ...(license !== listing.license ? { license } : {}),
        ...(seatCount !== listing.seats ? { seats: seatCount } : {}),
      });
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <TableRow data-testid="listing-row" data-listing={listing.id} data-license={listing.license} data-price={listing.priceAtomic}>
      <TableCell>
        <div className="font-mono text-xs text-text">{listing.id}</div>
        <div className="max-w-sm truncate text-xs text-text-muted" title={listing.title}>
          {listing.title}
        </div>
      </TableCell>
      <TableCell className="font-mono text-xs text-text-muted">{listing.sellerId}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <input className={`${INPUT} w-24`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label={`price of ${listing.id} in USDC`} />
          <span className="text-xs text-text-muted">
            now <Money atomic={listing.priceAtomic} size="sm" />
          </span>
        </div>
      </TableCell>
      <TableCell>
        <select className={SELECT} value={license} onChange={(e) => setLicense(e.target.value as License)} aria-label={`license of ${listing.id}`} title={LICENSE_EFFECT[license]}>
          {LICENSES.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <div className="mt-1 max-w-xs text-[11px] text-text-muted">{LICENSE_EFFECT[license]}</div>
      </TableCell>
      <TableCell>
        <input className={`${INPUT} w-16`} inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} aria-label={`seats of ${listing.id}`} />
      </TableCell>
      <TableCell>
        <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {issue ? <div className="mt-1 text-[11px] text-danger">{issue}</div> : null}
        {error ? <ErrorState error={error} title="Edit refused" className="mt-2" /> : null}
      </TableCell>
    </TableRow>
  );
}
