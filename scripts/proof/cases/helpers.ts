import type { Hex } from "viem";
import { formatError, sameError, type DecodedError } from "../decode.js";
import type { Sent } from "../context.js";
import { answerKey } from "../answer-key.js";
import { defineCase, type CheckResult, type LivePlan } from "../types.js";

/** A mined transaction reverted with exactly `want` (name and args), decoded from the mined tx. */
export function revertCheck(sent: Sent, want: DecodedError, extra = ""): CheckResult {
  const got = sent.decoded;
  const pass = sent.status === "reverted" && sameError(got, want);
  return { pass, actual: `${sent.status === "reverted" ? "reverted onchain" : "SUCCEEDED onchain"}: ${got ? formatError(got) : "undecoded"} (expected ${formatError(want)})${extra}`, txHash: sent.hash as Hex };
}

/** Relayer gas for `n` treasury transactions: what the live preflight checks. */
export const relayerOnly = (txs: number): LivePlan => ({ kind: "onchain", needs: { relayerTxs: txs, ownerTxs: 0, treasuryUsdc: 0n, sellerTxs: 0 } });

/** A case that has a file but no implementation in this build: always FAIL, never faked. */
export function notImplemented(id: number, slug: string, onchain: boolean) {
  return defineCase<null, null>({
    ...answerKey(id),
    slug,
    onchain,
    live: { kind: "offchain" }, // runs in both modes and reports FAIL: never faked
    setup: async () => null,
    action: async () => null,
    check: () => ({ pass: false, actual: "NOT IMPLEMENTED: this case has no harness yet (counts as a mismatch)" }),
  });
}
