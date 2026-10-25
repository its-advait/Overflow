import type { ChainTransaction, ComplaintRecord, EscrowChainState, EscrowOrder } from "@overflow/schemas";
import { Address, Mono, TxHash } from "@/components/shared/address";
import { Money } from "@/components/shared/money";
import { Field, Panel } from "@/components/shared/panel";
import { Pill, type Tone } from "@/components/shared/status-pill";
import { verifyComplaint, type ProofCheck } from "@/lib/escrow/evidence";
import { findEvent, formatUnix, refundReasonText, txArg, type Diagram } from "@/lib/escrow/state";

const COMPLAINT_STATUS: Record<ComplaintRecord["status"], { tone: Tone; hint: string }> = {
  built: { tone: "muted", hint: "Calldata built and verified locally; not sent." },
  submitted: { tone: "blue", hint: "Sent to the escrow; waiting for CheatProven." },
  proven: { tone: "success", hint: "CheatProven indexed: the contract accepted the proof." },
  rejected: { tone: "danger", hint: "The contract refused the complaint." },
};

function ProofRow({ label, root, service, browser }: { label: string; root: string; service: boolean; browser: ProofCheck | null }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2" data-testid="evidence-proof" data-browser={browser ? (browser.ok ? "ok" : "bad") : "skipped"}>
      <div className="min-w-0">
        <p className="text-sm text-text">{label}</p>
        <p className="truncate font-mono text-[11px] text-text-muted" title={root}>
          root {root}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Pill tone={service ? "success" : "danger"} title="as the service verified it before sending">
          service {service ? "ok" : "bad"}
        </Pill>
        {browser ? (
          <Pill tone={browser.ok ? "success" : "danger"} title={`verifyProof in this browser: ${browser.got} siblings, ${browser.expected} expected`}>
            browser {browser.ok ? "ok" : "bad"} · {browser.got}/{browser.expected}
          </Pill>
        ) : (
          <Pill tone="muted">browser: n/a</Pill>
        )}
      </div>
    </div>
  );
}

function EventLine({ tx, label }: { tx: ChainTransaction | undefined; label: string }) {
  if (!tx) return <p className="text-xs text-text-muted">{label}: no log indexed</p>;
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
      <span className="font-medium text-text">{label}</span>
      <TxHash value={tx.txHash} />
      <span>block {tx.blockNumber}</span>
    </p>
  );
}

/**
 * Why the money went where it went. A complaint shows the chunk, both Merkle proofs (service and browser
 * verification), the derived vs committed leaf and the CheatProven log; a timeout shows the deadline and the refund
 * log; a settlement shows who accepted and the PaidOut log. Nothing here is a conclusion the chain did not confirm.
 */
export function EvidencePanel({
  escrow,
  chain,
  complaint,
  chainTransactions,
  diagram,
}: {
  escrow: EscrowOrder;
  chain: EscrowChainState | null;
  complaint: ComplaintRecord | null;
  chainTransactions: readonly ChainTransaction[];
  diagram: Diagram;
}) {
  const cheatProven = findEvent(chainTransactions, "CheatProven");
  const cheatRecorded = findEvent(chainTransactions, "CheatRecorded");
  const refunded = findEvent(chainTransactions, "Refunded");
  const accepted = findEvent(chainTransactions, "Accepted");
  const paidOut = findEvent(chainTransactions, "PaidOut");
  const keyRevealed = findEvent(chainTransactions, "KeyRevealed");

  if (complaint) {
    const revealed = chain?.revealedKey && !/^0x0+$/.test(chain.revealedKey) ? chain.revealedKey : escrow.revealedKey;
    const check = verifyComplaint(complaint, escrow, revealed);
    const st = COMPLAINT_STATUS[complaint.status];
    return (
      <Panel
        title={`Evidence · complain${complaint.kind === "mismatch" ? "Mismatch" : "Promise"}(${complaint.chunkIndex}, …)`}
        aside={
          <>
            <span data-testid="complaint-status" className="contents">
              <Pill tone={st.tone} title={st.hint}>
                {complaint.status}
              </Pill>
            </span>
            {complaint.simulated ? <Pill tone="violet">SIMULATED seller</Pill> : null}
          </>
        }
      >
        <div className="flex flex-col gap-4" data-testid="evidence-complaint" data-kind={complaint.kind} data-accept={check.contractWouldAccept}>
          <p className="text-sm text-text">{complaint.detail}</p>
          <div className="flex flex-col gap-2">
            {complaint.kind === "mismatch" ? (
              <ProofRow label={`Ciphertext chunk #${complaint.chunkIndex} proves under rootCipher`} root={escrow.rootCipher} service={complaint.cipherProofVerified} browser={check.cipher} />
            ) : null}
            <ProofRow label={`${complaint.kind === "mismatch" ? "Committed plain leaf" : "Record leaf"} #${complaint.chunkIndex} proves under rootPlain`} root={escrow.rootPlain} service={complaint.plainProofVerified} browser={check.plain} />
          </div>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label="Committed plain leaf">
              <Mono value={check.committedLeaf} />
            </Field>
            <Field label="keccak256(decrypt(chunk, k_i)) derived">
              {check.derivedLeaf ? <Mono value={check.derivedLeaf} /> : complaint.derivedLeaf ? <Mono value={complaint.derivedLeaf} /> : <span className="text-xs text-text-muted">not derived</span>}
            </Field>
            <Field label="Cheat">
              <span className="flex flex-wrap items-center gap-2">
                <Pill tone={complaint.cheatVerified ? "danger" : "muted"} title="as the service recomputed it">
                  service: {complaint.cheatVerified ? "leaf differs" : "no cheat"}
                </Pill>
                <span data-testid="cheat-browser" data-cheat={check.cheat === null ? "unknown" : String(check.cheat)} className="contents">
                  <Pill tone={check.cheat === null ? "muted" : check.cheat ? "danger" : "success"} title="recomputed in this browser from the revealed key">
                    browser: {check.cheat === null ? "not re-checked" : check.cheat ? "leaf differs" : "matches"}
                  </Pill>
                </span>
              </span>
            </Field>
            <Field label="Decrypted row">
              <span className="font-mono text-[12px]">{check.decryptedRow ?? complaint.decryptedRow ?? <span className="text-text-muted">does not decode as a record</span>}</span>
            </Field>
          </dl>
          {check.note ? <p className="text-xs text-text-muted">{check.note}</p> : null}
          <p className="text-xs text-text-muted" data-testid="contract-would-accept">
            {check.contractWouldAccept ? "Every check the contract runs passes here too." : "This browser could not reproduce every check the contract runs; see above."}
          </p>
          <div className="flex flex-col gap-1 border-t border-border pt-3">
            <EventLine tx={keyRevealed} label="KeyRevealed" />
            <EventLine tx={cheatProven} label={cheatProven ? `CheatProven(seller ${txArg(cheatProven, "seller") ?? "?"}, index ${txArg(cheatProven, "index") ?? "?"})` : "CheatProven"} />
            <EventLine tx={cheatRecorded} label="CheatRecorded (factory)" />
            <EventLine tx={refunded} label={refunded ? `Refunded("${txArg(refunded, "reason") ?? ""}")` : "Refunded"} />
            {cheatProven ? (
              <p className="mt-1 flex items-center gap-2 text-xs">
                <Pill tone="danger">seller flagged</Pill>
                <Address value={txArg(cheatProven, "seller") ?? escrow.sellerAddress} chars={6} />
                <span className="text-text-muted">provenCheats +1 on the factory; this treasury pays this seller no more.</span>
              </p>
            ) : null}
          </div>
        </div>
      </Panel>
    );
  }

  if (diagram.current === "Refunded") {
    const reason = diagram.refundReason;
    return (
      <Panel title={`Evidence · Refunded("${reason ?? "?"}")`}>
        <div className="flex flex-col gap-3" data-testid="evidence-timeout">
          <p className="text-sm text-text">{refundReasonText(reason)}</p>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label="Reveal deadline">
              {formatUnix(escrow.revealDeadline)} <span className="text-xs text-text-muted">({escrow.revealDeadline})</span>
            </Field>
            <Field label="KeyRevealed">{keyRevealed ? <TxHash value={keyRevealed.txHash} /> : <span className="text-warning">no KeyRevealed log was ever indexed</span>}</Field>
            <Field label="Returned to the treasury">
              <Money atomic={BigInt(escrow.amountAtomic) + BigInt(escrow.bondAtomic)} />
              <span className="ml-2 text-xs text-text-muted">price + forfeited bond</span>
            </Field>
            <Field label="Refund transaction">{refunded ? <TxHash value={refunded.txHash} /> : <span className="text-text-muted">no Refunded log indexed</span>}</Field>
          </dl>
          {refunded ? (
            <p className="text-xs text-text-muted">
              Refunded(&quot;{txArg(refunded, "reason")}&quot;) at block {refunded.blockNumber}.
            </p>
          ) : null}
        </div>
      </Panel>
    );
  }

  if (diagram.current === "Settled") {
    return (
      <Panel title="Evidence · Settled">
        <div className="flex flex-col gap-3" data-testid="evidence-settled">
          <p className="text-sm text-text">
            {accepted ? "The buyer accepted delivery: a treasury node key signed Accept(orderId) and the escrow paid the seller at once." : "The challenge window closed without a proven complaint and finalizePayout() paid the seller."}
          </p>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label="Accepted by">
              {accepted ? (
                <span className="flex flex-wrap items-center gap-2">
                  <Address value={txArg(accepted, "signer") ?? ""} chars={6} />
                  <span className="text-xs text-text-muted">node {txArg(accepted, "nodeId")}</span>
                </span>
              ) : (
                <span className="text-xs text-text-muted">no Accepted log (quiet window)</span>
              )}
            </Field>
            <Field label="Paid out">
              {paidOut ? (
                <span className="flex flex-wrap items-center gap-2">
                  <Money atomic={BigInt(txArg(paidOut, "amount") ?? escrow.amountAtomic) + BigInt(txArg(paidOut, "bond") ?? escrow.bondAtomic)} />
                  <span className="text-xs text-text-muted">to</span>
                  <Address value={txArg(paidOut, "seller") ?? escrow.sellerAddress} chars={6} />
                </span>
              ) : (
                <span className="text-xs text-text-muted">no PaidOut log indexed</span>
              )}
            </Field>
          </dl>
          <EventLine tx={keyRevealed} label="KeyRevealed" />
          <EventLine tx={accepted} label="Accepted" />
          <EventLine tx={paidOut} label="PaidOut" />
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Evidence">
      <p className="text-sm text-text-muted" data-testid="evidence-open">
        {diagram.current === "Revealed"
          ? "No complaint has been built. Until the challenge window ends the buyer may prove a mismatch or a broken promise; after it, anyone may finalize the payout."
          : "No evidence yet. The seller must reveal the key before the reveal deadline; after it, anyone may claim the timeout refund."}
      </p>
    </Panel>
  );
}
