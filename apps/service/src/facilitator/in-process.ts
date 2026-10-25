import type { Address, Hex } from "@overflow/schemas";
import type { DecodedRevert } from "../chain/decode.js";
import type { Facilitator, SettleInput, SettleOutcome } from "./settle.js";

/**
 * The SIMULATED seller paywall's view of the facilitator, served by the facilitator HTTP app in-process
 * (app.request(), no socket) so the relayer key has exactly one nonce manager. Maps the app's /settle answers
 * onto the three paywall outcomes without ever inventing a success: `paid` only when the app reported
 * success with a transaction, `unknown` whenever the app itself was unsure, `blocked` otherwise.
 */
export interface SettleApp {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

export interface InProcessFacilitatorOptions {
  /** Forwarded as x-demo-token when the paywall asks for a forced broadcast (DEMO_MODE only). */
  demoToken?: string | undefined;
  log?: ((line: string) => void) | undefined;
}

type SettleAnswer = {
  success?: boolean;
  status?: string;
  errorReason?: string;
  transaction?: Hex;
  blockNumber?: string;
  nodeId?: string | null;
  payer?: Address;
  digest?: Hex;
  decoded?: { name?: string; args?: string[]; reason?: string };
  ok?: boolean;
  error?: { name?: string; reason?: string };
  original?: { status?: string; txHash?: Hex; result?: SettleAnswer };
};

function toDecoded(d: SettleAnswer["decoded"], fallback: string): DecodedRevert {
  const name = d?.name ?? "Unknown";
  const args = d?.args ?? [];
  return { name, args, decoded: `${name}(${args.join(",")})`, reason: d?.reason ?? fallback };
}

export function outcomeFromAnswer(status: number, body: SettleAnswer): SettleOutcome {
  if (status === 409 && body.original) {
    const o = body.original;
    if (o.result) return outcomeFromAnswer(200, o.result);
    // Submitted earlier, no stored result yet: the chain decides, never a retry.
    return { outcome: "unknown", reason: "digest already submitted; awaiting its receipt", digest: body.digest ?? ("0x" as Hex), ...(o.txHash ? { txHash: o.txHash } : {}) };
  }
  if (status !== 200) {
    const reason = body.error?.reason ?? body.errorReason ?? `facilitator answered ${status}`;
    return { outcome: "blocked", decoded: { name: body.error?.name ?? "FacilitatorError", args: [], decoded: `${body.error?.name ?? "FacilitatorError"}()`, reason } };
  }
  const digest = body.digest ?? ("0x" as Hex);
  if (body.success === true && body.transaction) {
    return {
      outcome: "paid",
      txHash: body.transaction,
      blockNumber: body.blockNumber ?? "",
      nodeId: body.nodeId ?? "",
      payer: body.payer ?? ("0x0000000000000000000000000000000000000000" as Address),
      digest,
    };
  }
  if (body.status === "unknown") {
    return { outcome: "unknown", reason: body.errorReason ?? "no receipt", digest, ...(body.transaction ? { txHash: body.transaction } : {}) };
  }
  return {
    outcome: "blocked",
    decoded: toDecoded(body.decoded, body.errorReason ?? "settle refused"),
    ...(body.transaction ? { txHash: body.transaction } : {}),
    ...(body.digest ? { digest: body.digest } : {}),
    ...(body.payer ? { payer: body.payer } : {}),
    ...(body.nodeId ? { nodeId: body.nodeId } : {}),
  };
}

export function facilitatorViaApp(app: SettleApp, opts: InProcessFacilitatorOptions = {}): Facilitator {
  return {
    async settle(input: SettleInput): Promise<SettleOutcome> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (input.forceBroadcast && opts.demoToken) headers["x-demo-token"] = opts.demoToken;
      const res = await app.request("/settle", {
        method: "POST",
        headers,
        body: JSON.stringify({ paymentPayload: input.payload, paymentRequirements: input.requirements, forceBroadcast: input.forceBroadcast }),
      });
      const body = (await res.json().catch(() => ({}))) as SettleAnswer;
      const out = outcomeFromAnswer(res.status, body);
      opts.log?.(`[sellers:SIMULATED] in-process /settle -> ${res.status} ${out.outcome}`);
      return out;
    },
  };
}
