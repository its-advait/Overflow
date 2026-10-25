import type { ResourceRecord, ResourceRequestRecord } from "@overflow/schemas";
import { Mono } from "@/components/shared/address";
import { Money } from "@/components/shared/money";
import { Simulated, SimulatedBadge } from "@/components/shared/simulated-badge";
import { Pill, type Tone } from "@/components/shared/status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { OracleDecision } from "@/lib/api/contracts";
import { comparisonRows, type ComparisonRow } from "@/lib/purchases/oracle";
import { Panel } from "./shared";

const VERDICT: Record<ComparisonRow["verdict"]["kind"], { label: string; tone: Tone }> = {
  chosen: { label: "Chosen", tone: "success" },
  alternative: { label: "Alternative", tone: "muted" },
  rejected: { label: "Rejected", tone: "danger" },
};

/**
 * Oracle's explanation for one request (SPEC "Oracle" > Explanation): every
 * candidate with its coverage, price and score; rejected listings show the
 * deterministic rule they failed. The decision authorizes nothing.
 */
export function ResourceComparison({
  decision,
  resources,
  request,
  requester,
}: {
  decision: OracleDecision;
  resources: readonly ResourceRecord[];
  request?: ResourceRequestRecord | undefined;
  requester?: string | undefined;
}) {
  const rows = comparisonRows(decision, resources, request);
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span>Oracle · {request ? request.topic : decision.requestId}</span>
          {requester ? <span className="text-xs text-text-muted">for {requester}</span> : null}
          {decision.simulated ? <SimulatedBadge what="catalog" /> : null}
        </span>
      }
      aside={<Mono value={decision.requestId} />}
    >
      {request ? (
        <p className="mb-3 text-xs text-text-muted">
          Needs {request.regions.join(", ")} · {request.dateRange.start} to {request.dateRange.end} · {request.granularity} · fields{" "}
          {request.requiredFields.join(", ")} · {request.format.join("/")} · {request.license} · fresh within {request.freshness.maxAgeDays} days · cap{" "}
          <Money atomic={request.maxPriceAtomic} size="sm" />
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Listing</TableHead>
              <TableHead>Coverage</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Score</TableHead>
              <TableHead>Verdict</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const v = VERDICT[row.verdict.kind];
              const l = row.listing;
              return (
                <TableRow key={row.listingId} className={row.verdict.kind === "rejected" ? "opacity-80" : ""}>
                  <TableCell className="text-xs text-text-muted">{row.rank ?? "–"}</TableCell>
                  <TableCell>
                    {l ? (
                      <div className="flex flex-col gap-0.5">
                        <Simulated when={l.simulated} what="seller">
                          <span className="text-sm text-text">{l.title}</span>
                        </Simulated>
                        <span className="font-mono text-[11px] text-text-muted">
                          {l.sellerId} · {l.license} · {l.seats} seat{l.seats === 1 ? "" : "s"}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-text-muted">
                        <Mono value={row.listingId} /> not in the catalog response
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-text-muted">
                    {l ? (
                      <>
                        {l.coverage.regions.join(", ")} · {l.coverage.dateRange.start} to {l.coverage.dateRange.end} · {l.coverage.granularity} ·{" "}
                        {l.coverage.format} · {l.coverage.fields.length} fields{l.coverage.asOf ? ` · as of ${l.coverage.asOf}` : ""}
                      </>
                    ) : (
                      "–"
                    )}
                  </TableCell>
                  <TableCell className="text-right">{l ? <Money atomic={l.priceAtomic} size="sm" /> : "–"}</TableCell>
                  <TableCell className="text-right text-xs text-text-muted">
                    {row.score ? (
                      <span title="price per covered requirement (regions + fields + dates + granularity + format); freshness breaks ties">
                        <Money atomic={row.score.pricePerCoveredAtomic} size="sm" unit={null} /> / req · {row.score.coveredRequirements} covered
                      </span>
                    ) : row.rank ? (
                      `rank ${row.rank}`
                    ) : (
                      "–"
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <Pill tone={v.tone}>{v.label}</Pill>
                      {row.verdict.kind === "rejected"
                        ? row.verdict.reasons.map((r, i) => (
                            <span key={`${r.reason}-${i}`} className="text-xs text-text-muted">
                              <span className="font-mono text-danger">{r.reason}</span>: {r.detail}
                            </span>
                          ))
                        : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {decision.assumptions.length ? (
        <ul className="mt-3 list-disc pl-5 text-xs text-text-muted">
          {decision.assumptions.map((a) => (
            <li key={a}>Assumption: {a}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 whitespace-pre-line text-xs text-text-muted">{decision.summary}</p>
    </Panel>
  );
}
