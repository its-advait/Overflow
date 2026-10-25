import { toAtomic, type ActivityEvent, type AgentRecord, type PurchaseRecord, type ResourceRecord } from "@overflow/schemas";

// ---------------------------------------------------------------------------
// Attribution from what the service actually wrote. ActivityEvent has no amount, counterparty, digest or
// model-call columns; the service puts them in the message in fixed shapes ("<n> USDC", "to 0x…",
// "for <url>", trailing "[kind:reference]" source tokens, "promptHash=0x… outputHash=0x…"). These
// parsers read only those shapes. Anything else yields undefined: the UI shows "—", never a guess.
// ---------------------------------------------------------------------------

export interface SourceRef {
  kind: string;
  reference: string;
}

export interface ParsedMessage {
  /** The message without its trailing bracket tokens. */
  text: string;
  /** `[kind:reference]` tokens, in order: facilitator digest, adapter, reconciliation trigger. */
  refs: SourceRef[];
  /** Bare tokens: "reverted onchain", "simulation", "MOCK SIMULATED". */
  flags: string[];
}

const TRAILING_TOKEN = /\s*\[([^[\]]+)\]\s*$/;
const REF = /^([a-z][a-z0-9-]*):(\S+)$/;

export function parseSourceRefs(message: string): ParsedMessage {
  let text = message;
  const tokens: string[] = [];
  for (let m = TRAILING_TOKEN.exec(text); m; m = TRAILING_TOKEN.exec(text)) {
    tokens.unshift(m[1]!.trim());
    text = text.slice(0, m.index);
  }
  const refs: SourceRef[] = [];
  const flags: string[] = [];
  for (const t of tokens) {
    const r = REF.exec(t);
    if (r) refs.push({ kind: r[1]!, reference: r[2]! });
    else flags.push(t);
  }
  return { text: text.trimEnd(), refs, flags };
}

/** The refused or settled authorization digest, when the service recorded it as `[facilitator:0x…]`. */
export function digestOf(message: string): `0x${string}` | undefined {
  const ref = parseSourceRefs(message).refs.find((r) => r.kind === "facilitator" && /^0x[0-9a-fA-F]{64}$/.test(r.reference));
  return ref?.reference as `0x${string}` | undefined;
}

export interface ModelCall {
  attempt: number;
  model: string;
  promptHash: `0x${string}`;
  outputHash: `0x${string}`;
  outcome: string;
}

const MODEL_CALL = /attempt=(\d+) model=(\S+) promptHash=(0x[0-9a-fA-F]{64}) outputHash=(0x[0-9a-fA-F]{64}) outcome=(\S+)/;

/** packages/oracle extract.ts: "oracle extraction attempt=<n> model=<m> promptHash=0x… outputHash=0x… outcome=<parsed|invalid>". */
export function parseModelCall(e: Pick<ActivityEvent, "kind" | "message">): ModelCall | undefined {
  if (e.kind !== "oracle.model_call") return undefined;
  const m = MODEL_CALL.exec(e.message);
  if (!m) return undefined;
  return { attempt: Number(m[1]), model: m[2]!, promptHash: m[3] as `0x${string}`, outputHash: m[4] as `0x${string}`, outcome: m[5]! };
}

export type Counterparty = { kind: "address"; value: `0x${string}` } | { kind: "url"; value: string } | { kind: "seller"; value: `0x${string}`; label: string };

const AMOUNT = /(?:^|[\s(])(\d+(?:\.\d{1,6})?) USDC\b/;
const TO_ADDRESS = /\bto (0x[0-9a-fA-F]{40})\b/;
const FOR_URL = /\bfor (https?:\/\/\S+?)(?=:\s|\s|$)/;

/** Amount (integer atomic units, parsed with the schema's decimal parser, never floats) and counterparty from the message. */
export function parseMoney(message: string): { amountAtomic?: string; counterparty?: Counterparty } {
  const out: { amountAtomic?: string; counterparty?: Counterparty } = {};
  const a = AMOUNT.exec(message);
  if (a) {
    try {
      out.amountAtomic = toAtomic(a[1]!);
    } catch {
      // not a USDC amount in the shape the service writes
    }
  }
  const to = TO_ADDRESS.exec(message);
  const url = FOR_URL.exec(message);
  if (to) out.counterparty = { kind: "address", value: to[1] as `0x${string}` };
  else if (url) out.counterparty = { kind: "url", value: url[1]! };
  return out;
}

export interface DescribeContext {
  agents?: readonly AgentRecord[] | undefined;
  purchases?: readonly PurchaseRecord[] | undefined;
  resources?: readonly ResourceRecord[] | undefined;
}

export interface EventDescription {
  /** Who did it: the agent's name and department, the raw id when unknown, or undefined (system / chain). */
  agent?: string;
  /** The message without the trailing source tokens. */
  action: string;
  amountAtomic?: string;
  counterparty?: Counterparty;
  purchase?: PurchaseRecord;
}

/**
 * A purchase-linked event takes its amount and seller from the stored purchase (the order is the source of
 * truth); other events from the message. Missing data stays missing.
 */
export function describeEvent(e: ActivityEvent, ctx: DescribeContext = {}): EventDescription {
  const parsed = parseSourceRefs(e.message);
  const money = parseMoney(parsed.text);
  const purchase = e.purchaseId ? ctx.purchases?.find((p) => p.id === e.purchaseId) : undefined;
  const agent = e.agentId ? (ctx.agents?.find((a) => a.id === e.agentId) ?? null) : undefined;
  const out: EventDescription = { action: parsed.text };
  if (agent) out.agent = `${agent.name} · ${agent.department}`;
  else if (e.agentId) out.agent = e.agentId;
  if (purchase) {
    out.purchase = purchase;
    out.amountAtomic = money.amountAtomic ?? purchase.amountAtomic;
    const resource = ctx.resources?.find((r) => r.id === purchase.resourceId);
    out.counterparty = { kind: "seller", value: purchase.sellerAddress, label: resource?.title ?? purchase.resourceId };
  } else {
    if (money.amountAtomic) out.amountAtomic = money.amountAtomic;
    if (money.counterparty) out.counterparty = money.counterparty;
  }
  return out;
}
