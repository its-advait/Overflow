"use client";

import { useState } from "react";
import { AddressSchema, MoneyFormatError, toAtomic, type TreasuryNodeView } from "@overflow/schemas";
import { ErrorState } from "@/components/shared/error-state";
import { Money } from "@/components/shared/money";
import { Pill } from "@/components/shared/status-pill";
import { SimulatedBadge } from "@/components/shared/simulated-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type RaiseExceptionBody, type RaiseExceptionResponse } from "@/lib/api";
import { PHASE_STYLE, phaseOf } from "@/lib/controller-phase";
import type { RequestMode } from "./agent-menu";

const REQUESTED_BY = "web-dashboard";

const TITLES: Record<RequestMode, { title: string; description: string }> = {
  pause: {
    title: "Pause this node",
    description: "Opens a PAUSE_REQUEST with the owner call pause(id). The node and its subtree keep running until the treasury's NodePaused event is indexed.",
  },
  "raise-cap": {
    title: "Raise this node's cap",
    description: "Opens a CAP_RAISE with the owner call raiseCap(id, newCap). The bar changes only after the CapRaised event is indexed.",
  },
  "add-payee": {
    title: "Add a payee to the treasury allowlist",
    description: "Opens a NEW_PAYEE with the owner call setAllow(payee, true). This is the treasury's GLOBAL allowlist: it applies to every unrestricted node, not just this one. A restricted node's own payees are fixed when it is created.",
  },
};

/**
 * Builds one onchain exception from the form and shows exactly what the service answered: a pending
 * ControllerRequest (PENDING) or the one already open for the same subject. It never shows DONE: that
 * phase comes from the indexed event through the request list.
 */
export function RequestDialog({
  target,
  onClose,
  onSubmitted,
}: {
  target: { mode: RequestMode; node: TreasuryNodeView } | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [payee, setPayee] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<RaiseExceptionResponse | null>(null);

  const reset = () => {
    setReason("");
    setAmount("");
    setPayee("");
    setFormError(null);
    setSubmitting(false);
    setError(null);
    setResult(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  if (!target) return null;
  const { mode, node } = target;
  const text = TITLES[mode];

  const build = (): RaiseExceptionBody | null => {
    const common = { requestedBy: REQUESTED_BY, reason: reason.trim(), ...(node.agent ? { agentId: node.agent.id } : {}) };
    if (common.reason.length === 0) {
      setFormError("Give the controller a reason.");
      return null;
    }
    if (mode === "pause") return { type: "PAUSE_REQUEST", ...common, nodeId: node.id };
    if (mode === "raise-cap") {
      let newCapAtomic: string;
      try {
        newCapAtomic = toAtomic(amount.trim());
      } catch (e) {
        setFormError(e instanceof MoneyFormatError ? e.message : "Enter a USDC amount like 25 or 25.50");
        return null;
      }
      if (BigInt(newCapAtomic) <= BigInt(node.cap)) {
        setFormError("The new cap must be above the current cap. Lowering a cap is not a treasury call.");
        return null;
      }
      return { type: "CAP_RAISE", ...common, nodeId: node.id, newCapAtomic };
    }
    const parsed = AddressSchema.safeParse(payee.trim());
    if (!parsed.success) {
      setFormError("Enter a 20-byte 0x address.");
      return null;
    }
    return { type: "NEW_PAYEE", ...common, payee: parsed.data };
  };

  const submit = async () => {
    setFormError(null);
    const body = build();
    if (!body) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.raiseException(body);
      setResult(r);
      onSubmitted();
    } catch (e) {
      setError(e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 px-4 text-sm">
          <div className="text-xs text-text-muted">
            node #{node.id} · {node.agent?.name ?? "unlabeled"} · cap <Money atomic={node.cap} size="sm" /> · spent <Money atomic={node.spent} size="sm" />
          </div>

          {result ? (
            <ResultView result={result} />
          ) : (
            <>
              {mode === "raise-cap" ? (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-text-muted">New cap (USDC, up to 6 decimals)</span>
                  <Input inputMode="decimal" placeholder="e.g. 40" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </label>
              ) : null}
              {mode === "add-payee" ? (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-text-muted">Payee address</span>
                  <Input className="font-mono" placeholder="0x…" value={payee} onChange={(e) => setPayee(e.target.value)} spellCheck={false} />
                </label>
              ) : null}
              <label className="flex flex-col gap-1">
                <span className="text-xs text-text-muted">Reason for the controller</span>
                <Input placeholder="Why the owner should sign this" value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              {formError ? <p className="text-xs text-danger">{formError}</p> : null}
              {error ? <ErrorState error={error} title="The service refused the request" /> : null}
            </>
          )}
        </div>

        <DialogFooter>
          {result ? (
            <Button onClick={close}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} disabled={submitting}>
                {submitting ? "Sending…" : "Create controller request"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResultView({ result }: { result: RaiseExceptionResponse }) {
  const r = result.request;
  const phase = r ? PHASE_STYLE[phaseOf(r)] : null;
  const simulated = r?.summary.includes("SIMULATED") ?? false;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised/60 p-3" data-testid="request-result">
      <div className="flex flex-wrap items-center gap-2">
        {phase ? (
          <Pill tone={phase.tone} title={phase.hint}>
            {phase.label}
          </Pill>
        ) : null}
        <span className="font-medium text-text">{result.created ? "Request created. Nothing has changed onchain." : "Already requested: an open request for this exists."}</span>
        {simulated ? <SimulatedBadge what="controller approval" /> : null}
      </div>
      {r ? (
        <>
          <p className="font-mono text-xs text-text-muted break-words">{r.summary}</p>
          <p className="text-xs text-text-muted">
            request <span className="font-mono">{r.id}</span> · exception <span className="font-mono">{result.exception.id}</span>
          </p>
          {r.submission ? (
            <a className="text-xs text-blue underline underline-offset-4" href={r.submission.approvalUrl} target="_blank" rel="noreferrer noopener">
              open the approval in Coinbase Wallet
            </a>
          ) : (
            <p className="text-xs text-text-muted">The controller has not sent it yet. The card updates when the treasury event is indexed.</p>
          )}
        </>
      ) : null}
    </div>
  );
}
