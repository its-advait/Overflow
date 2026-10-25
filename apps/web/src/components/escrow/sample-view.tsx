import type { EscrowOrder, SampleRecord } from "@overflow/schemas";
import { Mono } from "@/components/shared/address";
import { EmptyState } from "@/components/shared/empty-state";
import { Panel } from "@/components/shared/panel";
import { Pill, type Tone } from "@/components/shared/status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { rederiveIndices, sameIndices, verifySampleRows, type RowCheck } from "@/lib/escrow/evidence";
import { formatUnix } from "@/lib/escrow/state";

const VERDICT: Record<SampleRecord["verdict"], { tone: Tone; label: string }> = {
  buy: { tone: "success", label: "buy" },
  skip: { tone: "warning", label: "skip" },
};

function browserVerdict(c: RowCheck): { tone: Tone; label: string } {
  if (c.ok) return { tone: "success", label: "ok" };
  if (!c.cipher.ok) return { tone: "danger", label: `cipher proof (${c.cipher.got}/${c.cipher.expected})` };
  if (!c.plain.ok) return { tone: "danger", label: `plain proof (${c.plain.got}/${c.plain.expected})` };
  return { tone: "danger", label: c.decrypt === "mismatch" ? "decrypt ≠ leaf" : "decrypt failed" };
}

/**
 * The pre-funding sample: which chunks the buyer drew (re-derived here from the recorded randomness), each row
 * decrypted with the seller's revealed chunk key, the service's verification and this browser's, and the judgment
 * with its reason and who judged (a labelled rule or a model id).
 */
export function SampleView({ sample, escrow }: { sample: SampleRecord | null; escrow: EscrowOrder }) {
  if (!sample) {
    return (
      <Panel title="Sample">
        <EmptyState title="No sample recorded" description="The buyer judges a random sample of chunks before funding; none was stored for this order." className="py-8" />
      </Panel>
    );
  }
  const checks = verifySampleRows(sample, escrow);
  const rederived = sample.randomness ? rederiveIndices(sample.randomness, sample.indices.length, escrow.chunkCount) : null;
  const indicesOk = rederived ? sameIndices(rederived, sample.indices) : null;
  const verdict = VERDICT[sample.verdict];
  return (
    <Panel
      title="Sample"
      aside={
        <span data-testid="sample-verdict" className="contents">
          <Pill tone={verdict.tone} title={sample.reason}>
            {verdict.label}
          </Pill>
        </span>
      }
    >
      <div className="flex flex-col gap-4" data-testid="sample-view" data-verdict={sample.verdict}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span>Sampled indices</span>
          {sample.indices.map((i) => (
            <Pill key={i} tone="blue">
              #{i}
            </Pill>
          ))}
          <span>of {escrow.chunkCount} chunks</span>
          {rederived ? (
            <span data-testid="sample-indices-rederived" data-ok={indicesOk} className="contents">
              <Pill tone={indicesOk ? "success" : "danger"} title={`pickSampleIndices(${escrow.chunkCount}, ${sample.indices.length}, randomness) in this browser -> [${rederived.join(", ")}]`}>
                {indicesOk ? "indices re-derived in this browser: match" : `re-derived [${rederived.join(", ")}]: differ`}
              </Pill>
            </span>
          ) : (
            <Pill tone="muted">no randomness recorded</Pill>
          )}
        </div>
        {sample.randomness ? (
          <p className="text-xs text-text-muted">
            Randomness <Mono value={sample.randomness} />
          </p>
        ) : null}
        {sample.rows.length === 0 ? (
          <p className="text-xs text-text-muted">The service stored no decrypted rows for this sample.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Chunk</TableHead>
                <TableHead>Record timestamp</TableHead>
                <TableHead>Decrypted row</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>This browser</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sample.rows.map((r, i) => {
                const c = checks[i]!;
                const b = browserVerdict(c);
                return (
                  <TableRow key={r.index} data-testid="sample-row" data-index={r.index} data-browser={c.ok ? "ok" : "bad"}>
                    <TableCell className="tnum">#{r.index}</TableCell>
                    <TableCell className="text-text-muted">{r.timestamp ? formatUnix(r.timestamp) : c.timestamp ? formatUnix(c.timestamp) : "—"}</TableCell>
                    <TableCell className="font-mono text-[12px]">{r.row ?? c.row ?? <span className="text-text-muted">not a record</span>}</TableCell>
                    <TableCell>
                      <Pill tone={r.verified === "ok" ? "success" : "danger"}>{r.verified}</Pill>
                    </TableCell>
                    <TableCell>
                      <Pill tone={b.tone} title={`cipher proof ${c.cipher.ok ? "ok" : "bad"} (${c.cipher.got}/${c.cipher.expected} siblings) · plain proof ${c.plain.ok ? "ok" : "bad"} · decrypt ${c.decrypt}`}>
                        {b.label}
                      </Pill>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <div className="rounded-xl border border-border bg-surface-raised/50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">Judgment</span>
            <Pill tone={verdict.tone}>{verdict.label}</Pill>
            <span className="text-xs text-text-muted">judge: {sample.judge}</span>
            {sample.confidence !== undefined ? <span className="text-xs text-text-muted">confidence {sample.confidence}</span> : null}
          </div>
          <p className="mt-2 text-sm text-text">{sample.reason}</p>
          {sample.promptHash || sample.outputHash ? (
            <p className="mt-1 text-xs text-text-muted">
              {sample.promptHash ? `prompt ${sample.promptHash.slice(0, 12)}…` : ""} {sample.outputHash ? `output ${sample.outputHash.slice(0, 12)}…` : ""}
            </p>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
