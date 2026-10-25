"use client";

import { ESCROW_STATUSES, PURCHASE_STATUSES } from "@overflow/schemas";
import { ShieldCheck } from "lucide-react";
import { Address, Mono, TxHash } from "@/components/shared/address";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { MoneyActionPreview } from "@/components/shared/money-action-preview";
import { Simulated, SimulatedBadge } from "@/components/shared/simulated-badge";
import { SkeletonRows, SkeletonStat } from "@/components/shared/skeleton";
import { EscrowStatusPill, StatusPill } from "@/components/shared/status-pill";
import { MockBadge } from "@/components/shell/mock-badge";
import { PageHeader } from "@/components/shell/page-header";
import { ScriptedBadge } from "@/components/shell/scripted-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError } from "@/lib/api";
import * as fx from "@/lib/mocks";
import { useApiQuery } from "@/lib/use-api";

/**
 * Component demo. Everything below renders fixtures from src/lib/mocks and is
 * labelled MOCK. The MoneyActionPreview has no onConfirm: nothing on this page
 * can start a payment.
 */
export default function ComponentsDemoPage() {
  const ledger = useApiQuery(() => api.getLedger(), []);
  const merged = fx.purchaseById("pur-merged-national")!;
  const escrow = fx.escrowByPurchase(merged.id)!;

  return (
    <>
      <PageHeader
        title="Components"
        description="Every shared component with fixture data. Nothing here touches the chain or the service."
        actions={<MockBadge force />}
      />

      <div className="flex flex-col gap-10">
        <Section title="Money" note="formatUsdc on integer atomic units; sizes sm, md, lg, xl; signed and negative.">
          <div className="flex flex-wrap items-end gap-8">
            <Money atomic="250000000" size="xl" />
            <Money atomic="12000000" size="lg" />
            <Money atomic="8181818" size="md" />
            <Money atomic="1" size="sm" />
            <Money atomic="4500000" size="md" signed />
            <Money atomic={-15000000n} size="md" />
            <Money atomic="225500000" size="md" muted unit={null} />
          </div>
        </Section>

        <Section title="Address, TxHash, Mono" note="Monospace only here. Copy shows a check only after the clipboard call resolves. Links open Basescan.">
          <div className="flex flex-col gap-2">
            <Row label="Treasury">
              <Address value={fx.TREASURY_ADDRESS} />
            </Row>
            <Row label="USDC">
              <Address value={fx.USDC_ADDRESS} chars={6} />
            </Row>
            <Row label="Full">
              <Address value={fx.TREASURY_ADDRESS} full />
            </Row>
            <Row label="Tx">
              <TxHash value={merged.txHashes[0]!} />
            </Row>
            <Row label="Digest">
              <Mono value={merged.authorizationDigest!} />
            </Row>
          </div>
        </Section>

        <Section title="StatusPill" note="One variant per PurchaseStatus; hover for the meaning. Escrow states below.">
          <div className="flex flex-wrap gap-2">
            {PURCHASE_STATUSES.map((s) => (
              <StatusPill key={s} status={s} />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {ESCROW_STATUSES.map((s) => (
              <EscrowStatusPill key={s} status={s} />
            ))}
          </div>
        </Section>

        <Section title="Badges" note="SIMULATED marks demo sellers, datasets and the fictional company. MOCK marks fixture data. SCRIPTED marks a replayed demo beat.">
          <div className="flex flex-wrap items-center gap-3">
            <SimulatedBadge />
            <Simulated when what="seller">
              <span className="text-sm">Northstar Data</span>
            </Simulated>
            <MockBadge force />
            <ScriptedBadge />
          </div>
        </Section>

        <Section title="EmptyState, ErrorState, Skeleton">
          <div className="grid gap-4 lg:grid-cols-2">
            <EmptyState
              title="No purchases yet"
              description="Run a mission and the Oracle's proposals will appear here."
              action={<Button variant="outline">Compose a mission</Button>}
            />
            <div className="flex flex-col gap-4">
              <ErrorState
                error={new ApiError(409, "invalid_transition", "invalid purchase transition SETTLED -> RESERVED", undefined, "req_mock_01")}
                title="Authorization refused"
                action={<Button variant="outline" size="sm">Reload</Button>}
              />
              <ErrorState error={new Error("fetch failed: ECONNREFUSED 127.0.0.1:4000")} />
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <SkeletonRows rows={4} />
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <SkeletonStat />
            </div>
          </div>
        </Section>

        <Section
          title="MoneyActionPreview"
          note="Payer, amount, destination and expected outcome before anything runs. The confirm button is disabled: this demo wires no onConfirm, and the second card is missing its destination."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <MoneyActionPreview
              title="Authorize purchase"
              payer={{ label: `Node ${merged.payingNodeId} · mission root (treasury)`, address: merged.buyerTreasury }}
              amountAtomic={merged.amountAtomic}
              destination={{ label: "Escrow for US grocery price index", address: escrow.escrowAddress }}
              expectedOutcome="The treasury checks the policy, then OrderFunded is confirmed onchain. The seller is paid only after a verified reveal."
              confirmLabel="Sign authorization"
            />
            <MoneyActionPreview
              title="Refund escrow"
              payer={{ label: "Escrow (SIMULATED seller missed the reveal)", address: escrow.escrowAddress }}
              amountAtomic={escrow.amountAtomic}
              destination={null}
              expectedOutcome={null}
              confirmLabel="Refund"
            />
          </div>
        </Section>

        <Section title="Typed client" note="api.getLedger() through the mock client, parsed by LedgerResponseSchema.">
          {ledger.loading ? (
            <SkeletonRows rows={3} />
          ) : ledger.error ? (
            <ErrorState error={ledger.error} />
          ) : (
            <div className="rounded-xl border border-border bg-surface">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right">Debits</TableHead>
                    <TableHead className="text-right">Credits</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ledger.data?.balances.map((b) => (
                    <TableRow key={b.account}>
                      <TableCell className="font-mono text-xs">{b.account}</TableCell>
                      <TableCell className="text-right">
                        <Money atomic={b.debitsAtomic} size="sm" unit={null} muted />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money atomic={b.creditsAtomic} size="sm" unit={null} muted />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money atomic={b.netAtomic} size="sm" unit={null} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="flex items-center gap-1.5 border-t border-border px-4 py-2 text-xs text-text-muted">
                <ShieldCheck className="size-3.5" aria-hidden />
                Source: <span className="font-mono">{api.source}</span> · {ledger.data?.entries.length} entries
              </p>
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      {note ? <p className="mt-0.5 mb-3 text-xs text-text-muted">{note}</p> : <div className="mb-3" />}
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 text-xs text-text-muted">{label}</span>
      {children}
    </div>
  );
}
