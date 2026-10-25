"use client";

import Link from "next/link";
import { Money } from "@/components/shared/money";
import { Panel } from "@/components/shared/panel";
import { Pill } from "@/components/shared/status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AllocationBreakdown, Balance, DepartmentBalance } from "@/lib/api/contracts";
import { ACCOUNT_STYLE, normalBalance, trialBalance } from "@/lib/ledger/accounts";
import { byDepartment, byPurchase, formatBps } from "@/lib/ledger/allocations";

/** Balances by account (trial balance), by department, and the Fusion allocation breakdown per purchase. */
export function BalancesPanel({ balances, departments, allocations }: { balances: readonly Balance[]; departments: readonly DepartmentBalance[]; allocations: readonly AllocationBreakdown[] }) {
  const tb = trialBalance(balances);
  const purchases = byPurchase(allocations);
  const deptBreakdown = byDepartment(allocations);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel
        title="Balances by account"
        aside={
          <Pill tone={tb.balanced ? "success" : "danger"} title="Σ debits vs Σ credits over every row">
            {tb.balanced ? "Trial balance: debits = credits" : "Trial balance: out of balance"}
          </Pill>
        }
        className="lg:col-span-2"
      >
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Debits</TableHead>
                <TableHead className="text-right">Credits</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {balances.map((b) => {
                const style = ACCOUNT_STYLE[b.account];
                return (
                  <TableRow key={b.account}>
                    <TableCell className="text-sm" title={style.hint}>
                      {style.label}
                    </TableCell>
                    <TableCell className="text-xs text-text-muted">
                      {style.kind} · {style.normal}-normal
                    </TableCell>
                    <TableCell className="text-right">
                      <Money atomic={b.debitsAtomic} size="sm" unit={null} muted />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money atomic={b.creditsAtomic} size="sm" unit={null} muted />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money atomic={normalBalance(b)} size="sm" />
                    </TableCell>
                  </TableRow>
                );
              })}
              <TableRow>
                <TableCell colSpan={2} className="text-xs text-text-muted">
                  Totals
                </TableCell>
                <TableCell className="text-right">
                  <Money atomic={tb.debitsAtomic} size="sm" unit={null} />
                </TableCell>
                <TableCell className="text-right">
                  <Money atomic={tb.creditsAtomic} size="sm" unit={null} />
                </TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </Panel>

      <Panel title="Data expense by department">
        {departments.length === 0 ? (
          <p className="text-sm text-text-muted">No department has been expensed yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Department</TableHead>
                  <TableHead>Purchases</TableHead>
                  <TableHead className="text-right">Expense</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {departments.map((d) => {
                  const detail = deptBreakdown.find((x) => x.department === d.department);
                  return (
                    <TableRow key={d.department}>
                      <TableCell className="text-sm capitalize">{d.department}</TableCell>
                      <TableCell className="text-xs text-text-muted">
                        {detail ? (
                          <span className="flex flex-wrap gap-1">
                            {detail.purchases.map((p) => (
                              <Link key={p.purchaseId} href={`/purchases/${encodeURIComponent(p.purchaseId)}`} className="font-mono text-blue hover:underline">
                                {p.purchaseId}
                                {p.merged ? " (merged)" : ""}
                              </Link>
                            ))}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Money atomic={d.netAtomic} size="sm" />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      <Panel title="Fusion allocation breakdown" aside={<span className="text-xs text-text-muted">planned share vs booked expense, per purchase</span>}>
        {purchases.length === 0 ? (
          <p className="text-sm text-text-muted">No purchase has department lines yet.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {purchases.map((p) => (
              <div key={p.purchaseId} className="rounded-lg border border-border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <span className="flex items-center gap-2">
                    <Link href={`/purchases/${encodeURIComponent(p.purchaseId)}`} className="font-mono text-xs text-blue hover:underline">
                      {p.purchaseId}
                    </Link>
                    {p.merged ? (
                      <Pill tone="violet" title={`Fusion purchase group ${p.purchaseGroupId}: several agents' requests, one transfer onchain`}>
                        merged
                      </Pill>
                    ) : null}
                  </span>
                  <span className="text-xs text-text-muted">
                    booked <Money atomic={p.bookedAtomic} size="sm" unit={null} /> of <Money atomic={p.allocatedAtomic} size="sm" unit={null} muted /> planned
                  </span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Department</TableHead>
                      <TableHead className="text-right">Planned</TableHead>
                      <TableHead className="text-right">Booked</TableHead>
                      <TableHead className="text-right">Share of booked</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {p.lines.map((l) => (
                      <TableRow key={l.department}>
                        <TableCell className="text-sm capitalize">{l.department}</TableCell>
                        <TableCell className="text-right">
                          {l.allocatedAtomic === null ? <span className="text-xs text-text-muted">no plan</span> : <Money atomic={l.allocatedAtomic} size="sm" unit={null} muted />}
                        </TableCell>
                        <TableCell className="text-right">
                          <Money atomic={l.bookedAtomic} size="sm" unit={null} />
                        </TableCell>
                        <TableCell className="text-right text-xs text-text-muted">{l.bookedAtomic === 0n ? "—" : formatBps(l.shareBps)}</TableCell>
                        <TableCell className="text-right">
                          {l.bookedAtomic === 0n ? (
                            <Pill tone="muted" title="Nothing expensed yet: the order has not settled">in escrow</Pill>
                          ) : l.matches ? (
                            <Pill tone="success">matches plan</Pill>
                          ) : (
                            <Pill tone="warning" title="Booked differs from the planned share (chain amount scaled or corrected)">
                              differs
                            </Pill>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
