import type { Address, ControllerRequest } from "@overflow/schemas";
import type { JsonArgs } from "../chain/decode.js";

/**
 * Does a stored treasury event satisfy a pending ControllerRequest? Exact
 * match only: the controller approved this calldata, so the event must carry
 * the same payee/flag, node/cap or node. A different outcome leaves the
 * request pending for the controller to reject.
 *
 * NodePaused is also emitted by `pauseChild`, which any ancestor key can relay; when the treasury owner is known,
 * only a pause sent by the owner (`by`) completes an owner request.
 */
export function requestMatchesLog(
  request: ControllerRequest,
  eventName: string,
  args: JsonArgs,
  opts: { owner?: Address | null | undefined } = {},
): boolean {
  const a = request.action;
  const str = (k: string): string => String(args[k] ?? "");
  switch (eventName) {
    case "AllowSet":
      return a.kind === "set-allow" && str("payee").toLowerCase() === a.payee.toLowerCase() && args["allowed"] === a.allowed;
    case "CapRaised":
      return a.kind === "raise-cap" && str("id") === String(a.nodeId) && str("newCap") === a.newCapAtomic;
    case "NodePaused":
      return (
        a.kind === "pause" &&
        str("id") === String(a.nodeId) &&
        (!opts.owner || str("by").toLowerCase() === opts.owner.toLowerCase())
      );
    default:
      return false;
  }
}

/** Treasury events that can complete a ControllerRequest. */
export const COMPLETING_EVENTS = ["AllowSet", "CapRaised", "NodePaused"] as const;
