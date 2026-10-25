import { Check, X } from "lucide-react";
import type { AgentRecord, PurchaseGroup, PurchaseRecord, ResourceRecord, ResourceRequestRecord } from "@overflow/schemas";
import { Mono } from "@/components/shared/address";
import { Money } from "@/components/shared/money";
import { Simulated } from "@/components/shared/simulated-badge";
import { Pill } from "@/components/shared/status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { FusionOutcome, OracleDecision } from "@/lib/api/contracts";
import { avoidedDuplicateCost, MERGE_RULES, RULE_LABELS } from "@/lib/purchases/fusion";
import { agentLabel, Field, Panel } from "./shared";

/**
 * One Fusion decision (SPEC "Fusion" > Merge rules): the requests judged
 * together, every rule with its pass/fail evidence, who pays, the subledger
 * allocations and the duplicate spend one purchase avoids. It authorizes nothing.
 */
export function FusionProposal({
  outcome,
  requests,
  agents,
  resources,
  decisions,
  purchase,
}: {
  outcome: FusionOutcome;
  requests: readonly ResourceRequestRecord[];
  agents: readonly AgentRecord[];
  resources: readonly ResourceRecord[];
  decisions: readonly OracleDecision[];
  purchase?: PurchaseRecord | undefined;
}) {
  const listing = outcome.listingId ? resources.find((r) => r.id === outcome.listingId) : undefined;
  const avoided = avoidedDuplicateCost(outcome, decisions, resources);
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span>Fusion · {outcome.requestIds.length} requests</span>
          {outcome.merge ? <Pill tone="success">Merged</Pill> : <Pill tone="danger">Refused to merge: {outcome.failingRules.join(", ")}</Pill>}
        </span>
      }
      aside={
        listing ? (
          <Simulated when={listing.simulated} what="seller">
            <span className="text-xs text-text">{listing.title}</span>
          </Simulated>
        ) : outcome.listingId ? (
          <Mono value={outcome.listingId} />
        ) : (
          <span className="text-xs text-text-muted">no shared listing</span>
        )
      }
    >
      <p className="text-sm text-text">{outcome.reason}</p>

      <h4 className="mt-4 text-[10px] font-medium uppercase tracking-wider text-text-muted">Requests judged together</h4>
      <ul className="mt-1 grid gap-2 sm:grid-cols-2">
        {outcome.requestIds.map((id) => {
          const r = requests.find((x) => x.id === id);
          return (
            <li key={id} className="rounded-lg border border-border bg-surface-raised/40 p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-text">{r ? agentLabel(agents, r.agentId) : id}</span>
                {outcome.waitingRequestIds.includes(id) ? <Pill tone="warning">waits</Pill> : null}
              </div>
              {r ? (
                <p className="mt-1 text-text-muted">
                  {r.topic} · {r.regions.join(", ")} · {r.granularity} · {r.license} · cap <Money atomic={r.maxPriceAtomic} size="sm" unit={null} /> USDC
                </p>
              ) : (
                <p className="mt-1 text-text-muted">
                  <Mono value={id} /> (request not in the mission response)
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <h4 className="mt-4 text-[10px] font-medium uppercase tracking-wider text-text-muted">Merge rules (all must pass)</h4>
      <div className="mt-1 overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Rule</TableHead>
              <TableHead>Evidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {MERGE_RULES.map((rule) => {
              const check = outcome.checks.find((c) => c.rule === rule);
              const label = RULE_LABELS[rule];
              return (
                <TableRow key={rule} className={check && !check.passed ? "bg-danger/5" : ""}>
                  <TableCell>
                    {check ? (
                      check.passed ? (
                        <Check className="size-4 text-success" aria-label="passed" />
                      ) : (
                        <X className="size-4 text-danger" aria-label="failed" />
                      )
                    ) : (
                      <span className="text-xs text-text-muted">–</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm text-text">{label.title}</div>
                    <div className="text-[11px] text-text-muted">{label.rule}</div>
                  </TableCell>
                  <TableCell className={`text-xs ${check && !check.passed ? "text-danger" : "text-text-muted"}`}>
                    {check ? check.evidence : "not evaluated"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="Payer">
          {outcome.payer ? (
            <>
              Node {outcome.payer.nodeId}
              {outcome.payer.agentId ? ` · ${agentLabel(agents, outcome.payer.agentId)}` : " · mission root"}
              <div className="text-xs text-text-muted">
                {outcome.payer.rule}: {outcome.payer.evidence}
              </div>
            </>
          ) : (
            <span className="text-text-muted">No shared purchase. Requests stay separate.</span>
          )}
        </Field>
        <Field label="Waiting requests">
          {outcome.waitingRequestIds.length ? (
            <span className="text-warning">{outcome.waitingRequestIds.join(", ")} · a second seat needs its own order once this one settles</span>
          ) : (
            <span className="text-text-muted">none</span>
          )}
        </Field>
        <Field label="Avoided duplicate cost">
          {avoided ? (
            <>
              <Money atomic={avoided.savedAtomic} size="lg" />
              <div className="text-xs text-text-muted">
                one purchase <Money atomic={avoided.mergedAtomic} size="sm" unit={null} /> vs <Money atomic={avoided.separateAtomic} size="sm" unit={null} /> separately (
                {avoided.parts.map((p) => p.listingId).join(" + ")})
              </div>
            </>
          ) : (
            <span className="text-text-muted">{outcome.merge ? "listing missing from the catalog response" : "no saving: not merged"}</span>
          )}
        </Field>
      </dl>

      {purchase ? <Allocations purchase={purchase} agents={agents} /> : null}
    </Panel>
  );
}

/** Subledger shares of one purchase by agent and department; the sum equals the one onchain transfer. */
export function Allocations({ purchase, agents }: { purchase: PurchaseRecord; agents: readonly AgentRecord[] }) {
  const total = BigInt(purchase.amountAtomic);
  return (
    <>
      <h4 className="mt-4 text-[10px] font-medium uppercase tracking-wider text-text-muted">Allocations (subledger; caps untouched)</h4>
      <div className="mt-1 overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Department</TableHead>
              <TableHead className="text-right">Share</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {purchase.allocations.map((a) => (
              <TableRow key={`${a.agentId}-${a.department}`}>
                <TableCell className="text-sm">{agentLabel(agents, a.agentId)}</TableCell>
                <TableCell className="text-sm capitalize">{a.department}</TableCell>
                <TableCell className="text-right text-xs text-text-muted">
                  {total > 0n ? `${((BigInt(a.amountAtomic) * 10000n) / total / 100n).toString()}.${(((BigInt(a.amountAtomic) * 10000n) / total) % 100n).toString().padStart(2, "0")}%` : "–"}
                </TableCell>
                <TableCell className="text-right">
                  <Money atomic={a.amountAtomic} size="sm" />
                </TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell colSpan={3} className="text-xs text-text-muted">
                One transfer onchain from node {purchase.payingNodeId}
              </TableCell>
              <TableCell className="text-right">
                <Money atomic={purchase.amountAtomic} size="sm" />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/** Persisted fallback when no propose response is in this session: the stored merge reason, labelled as such. */
export function StoredFusionSummary({ group, purchase, agents }: { group: PurchaseGroup; purchase: PurchaseRecord; agents: readonly AgentRecord[] }) {
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span>Fusion · {group.requestIds.length} requests</span>
          <Pill tone="muted">Stored summary</Pill>
        </span>
      }
      aside={<span className="text-xs text-text-muted">Rule-by-rule evidence comes from a proposal run in this session.</span>}
    >
      <p className="text-sm text-text">{group.mergeReason}</p>
      <p className="mt-1 text-xs text-text-muted">
        Requests {group.requestIds.join(", ")} · payer node {group.payingNodeId}
      </p>
      <Allocations purchase={purchase} agents={agents} />
    </Panel>
  );
}
