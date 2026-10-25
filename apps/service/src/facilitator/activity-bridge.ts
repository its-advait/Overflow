import type { Repositories } from "@overflow/database";
import type { ActivityBus } from "../chain/bus.js";
import { BYPASS_REASON } from "./decode.js";
import type { Bus, FeedEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Bridge from the facilitator's in-memory feed to the audit trail the API serves.
//
// Only `BypassRejected` crosses: the SIMULATED attacker's authorization sent straight to USDC, which USDC refused
// after asking the treasury (ERC-1271). Nobody else records that refusal (no agent tool made the call, the tx has
// no logs for the indexer), so this is its only path into the Blocked lane.
//
// `Reverted` does NOT cross: the callers that know the agent and mission (orchestration/tools.ts for a seller's
// 402, orchestration/delegation.ts for a refused CreateChild/PauseChild) already write their own policy.blocked
// row; a second, unattributed row per refusal would double-count the lane. Direct callers of /settle or /verify
// from outside the service remain visible on GET /facilitator/events only.
//
// `BypassSucceeded` is logged loudly and otherwise left alone: a real USDC Transfer means the indexer records a
// `usdc.transfer` row and reconciliation opens a difference. Nothing here invents a refusal that did not happen.
// ---------------------------------------------------------------------------

export interface FacilitatorActivityBridgeDeps {
  facilitatorBus: Bus;
  repos: Pick<Repositories, "activityEvents">;
  activityBus: ActivityBus;
  log?: ((message: string) => void) | undefined;
}

/** The decoded revert as the activity feed records it: `Name(arg,arg)`; the bypass's default when USDC gave no data. */
export function decodedRevertOf(e: Pick<FeedEvent, "decoded">): string {
  if (e.decoded?.name) return `${e.decoded.name}(${e.decoded.args.join(",")})`;
  return "Error(FiatTokenV2: invalid signature)";
}

export function bypassRefusalMessage(e: Pick<FeedEvent, "decoded" | "digest">): string {
  const reason = e.decoded?.reason ?? BYPASS_REASON;
  return `SIMULATED attacker bypass: USDC refused transferWithAuthorization sent outside settle(): ${reason}${e.digest ? ` [facilitator:${e.digest}]` : ""}`;
}

/** Subscribes; returns the unsubscribe. Insert failures are logged, never thrown into the facilitator's publish loop. */
export function bridgeFacilitatorRefusals(deps: FacilitatorActivityBridgeDeps): () => void {
  const log = deps.log ?? ((m: string) => console.log(`[facilitator] ${m}`));
  return deps.facilitatorBus.subscribe((e) => {
    if (e.kind === "BypassSucceeded") {
      log(`WARNING: SIMULATED bypass ${e.digest ?? "?"} was ACCEPTED by USDC (tx ${e.txHash ?? "?"}); the indexer's usdc.transfer and reconciliation will show it`);
      return;
    }
    if (e.kind !== "BypassRejected") return;
    void deps.repos.activityEvents
      .insert({
        kind: "policy.blocked",
        message: bypassRefusalMessage(e),
        decodedRevert: decodedRevertOf(e),
        ...(e.txHash ? { txHash: e.txHash } : {}),
        simulated: true,
      })
      .then((row) => deps.activityBus.publish(row))
      .catch((err: unknown) => log(`could not record bypass refusal ${e.digest ?? "?"}: ${err instanceof Error ? err.message : String(err)}`));
  });
}
