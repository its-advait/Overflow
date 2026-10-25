"use client";

import { useState } from "react";
import type { AgentRecord, PurchaseRecord, ResourceRecord } from "@overflow/schemas";
import { Address, Mono, TxHash } from "@/components/shared/address";
import { ErrorState } from "@/components/shared/error-state";
import { MoneyActionPreview } from "@/components/shared/money-action-preview";
import { Simulated } from "@/components/shared/simulated-badge";
import { Pill, StatusPill } from "@/components/shared/status-pill";
import { api } from "@/lib/api";
import type { AuthorizeResponse } from "@/lib/api/contracts";
import { idempotencyKeyFor } from "@/lib/purchases/propose-cache";
import { Allocations } from "./fusion-proposal";
import { agentLabel, Field, formatWhen, Panel } from "./shared";

/**
 * Everything the agent is about to sign (SPEC "UI": payer, amount, destination
 * and expected outcome before anything runs), then the adapter's report,
 * rendered exactly as returned. Funding and settlement never come from here:
 * the timeline reads them from GET /api/purchases/:id after the chain confirms.
 */
export function PurchaseAuthorization({
  purchase,
  resource,
  agents,
  payerEvidence,
  onAuthorized,
}: {
  purchase: PurchaseRecord;
  resource?: ResourceRecord | undefined;
  agents: readonly AgentRecord[];
  payerEvidence?: string | undefined;
  onAuthorized?: ((r: AuthorizeResponse) => void) | undefined;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AuthorizeResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Evaluated once per mount; the service re-checks expiry when it signs.
  const [now] = useState(() => Date.now());
  const expired = Date.parse(purchase.authorizationExpiresAt) <= now;
  const authorizable = purchase.status === "PROPOSED" && !expired && !result;
  const payerAgent = agents.find((a) => a.nodeId === purchase.payingNodeId);

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      // One key per purchase for this session: a retry replays the same authorization, never a new one.
      const r = await api.authorizePurchase(purchase.id, idempotencyKeyFor(purchase.id));
      setResult(r);
      onAuthorized?.(r);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <MoneyActionPreview
        title={purchase.status === "PROPOSED" ? "Authorize purchase" : "Authorization"}
        payer={{
          label: `Node ${purchase.payingNodeId}${payerAgent ? ` · ${payerAgent.name}` : ""} (treasury)${payerEvidence ? ` · ${payerEvidence}` : ""}`,
          address: purchase.buyerTreasury,
        }}
        amountAtomic={purchase.amountAtomic}
        destination={{ label: `Escrow for ${resource?.title ?? purchase.resourceId}`, address: purchase.escrowAddress }}
        expectedOutcome="The treasury checks policy (cap, payee, pause, expiry), then OrderFunded is confirmed onchain. The seller is paid only after a verified reveal; otherwise the escrow refunds the treasury."
        confirmLabel="Sign authorization"
        onConfirm={authorizable ? confirm : undefined}
        disabled={!authorizable}
        pending={pending}
        footnote={
          purchase.status !== "PROPOSED" ? (
            <span className="flex items-center gap-2">
              <StatusPill status={purchase.status} /> This purchase is past authorization.
            </span>
          ) : expired ? (
            <span className="text-warning">Authorization window expired at {formatWhen(purchase.authorizationExpiresAt)}; propose again.</span>
          ) : undefined
        }
      />

      <Panel title="Order terms (fixed by the seller's order; hashed over ABI-encoded fields)">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Seller">
            <Simulated when={resource?.simulated} what="seller">
              <Address value={purchase.sellerAddress} />
            </Simulated>
          </Field>
          <Field label="Escrow">
            <Address value={purchase.escrowAddress} />
          </Field>
          <Field label="Terms hash">
            <Mono value={purchase.termsHash} />
          </Field>
          <Field label="Order id">
            <Mono value={purchase.orderIdBytes32} />
          </Field>
          <Field label="Manifest hash">
            <Mono value={purchase.resourceManifestHash} />
          </Field>
          <Field label="Payment path">
            <span className="font-mono text-xs">{purchase.paymentPath}</span> · chain {purchase.chainId}
          </Field>
          <Field label="Authorization expires">
            <span className={expired ? "text-warning" : ""}>{formatWhen(purchase.authorizationExpiresAt)}</span>
          </Field>
          <Field label="Authorization digest">{purchase.authorizationDigest ? <Mono value={purchase.authorizationDigest} /> : <span className="text-text-muted">not signed yet</span>}</Field>
          <Field label="Participating agents">{purchase.participatingAgentIds.map((id) => agentLabel(agents, id)).join(", ")}</Field>
        </dl>
        <Allocations purchase={purchase} agents={agents} />
      </Panel>

      {error ? <ErrorState error={error} title="Authorization refused" /> : null}
      {result ? <SubmissionResult result={result} /> : null}
    </div>
  );
}

/** The adapter's report, verbatim. "submitted" is a broadcast, not funding; ESCROW_FUNDED only ever comes from the indexed OrderFunded event. */
function SubmissionResult({ result }: { result: AuthorizeResponse }) {
  const s = result.submission;
  const tone = s.outcome === "submitted" ? "blue" : s.outcome === "rejected" ? "danger" : "warning";
  return (
    <section className={`rounded-xl border p-4 ${tone === "danger" ? "border-danger/30 bg-danger/5" : tone === "warning" ? "border-warning/30 bg-warning/5" : "border-blue/30 bg-blue/5"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={tone}>{s.outcome}</Pill>
        <StatusPill status={result.purchase.status} />
        {result.replayed ? <Pill tone="muted">replayed (same Idempotency-Key)</Pill> : null}
      </div>
      <div className="mt-2 text-sm text-text">
        {s.outcome === "submitted" ? (
          <>
            Broadcast <TxHash value={s.txHash} />. Waiting for the indexer to confirm OrderFunded; nothing is funded until it does.
          </>
        ) : s.outcome === "rejected" ? (
          <>
            Treasury policy revert: <span className="font-mono text-danger">{s.decodedRevert}</span>. No funds moved.
          </>
        ) : (
          <>
            Broadcast without a receipt: <span className="font-mono">{s.error}</span>. Reconcile against the chain; never retry with a new nonce.
          </>
        )}
      </div>
      <p className="mt-1 text-xs text-text-muted">
        Digest <Mono value={result.authorizationDigest} />
      </p>
    </section>
  );
}
