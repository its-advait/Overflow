import { createRepositories, NotFoundError, type Db, type Repositories } from "@overflow/database";
import {
  AddressSchema,
  AtomicAmountSchema,
  ExceptionDecisionSchema,
  IdSchema,
  isOnchainExceptionType,
  type ActivityEvent,
  type Address,
  type ControllerAction,
  type ControllerRequest,
  type ControllerRequestStatus,
  type ExceptionRecord,
  type ExceptionStatus,
  type Hex,
} from "@overflow/schemas";
import { z } from "zod";
import { NotWiredError } from "../api/ports.js";
import type { ActivityBus } from "../chain/bus.js";
import type { JsonArgs } from "../chain/decode.js";
import { buildControllerCall } from "./calldata.js";
import { requestMatchesLog } from "./matching.js";

// ---------------------------------------------------------------------------
// Exceptions (docs/SPEC.md "When it asks a human", "Segregation of duties").
// Every case where Overflow must ask a human is a typed exception. Onchain
// types (NEW_PAYEE, CAP_RAISE, PAUSE_REQUEST) also get a ControllerRequest with
// the prepared owner calldata; it is "done" only when the indexer stores the
// matching treasury event. Offchain types record the controller's decision
// with who and why. The requester can never decide its own exception.
// ---------------------------------------------------------------------------

const Common = {
  requestedBy: z.string().min(1),
  reason: z.string().min(1).max(2000),
  agentId: IdSchema.optional(),
  purchaseId: IdSchema.optional(),
  amountAtomic: AtomicAmountSchema.optional(),
};

export const RaiseExceptionInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("NEW_PAYEE"), ...Common, payee: AddressSchema }),
  z.object({ type: z.literal("CAP_RAISE"), ...Common, nodeId: z.number().int().positive(), newCapAtomic: AtomicAmountSchema }),
  z.object({ type: z.literal("PAUSE_REQUEST"), ...Common, nodeId: z.number().int().positive() }),
  z.object({ type: z.literal("UNCLEAR_LICENSE"), ...Common, resourceId: IdSchema, license: z.string().min(1) }),
  z.object({
    type: z.literal("LOW_CONFIDENCE_SAMPLE"),
    ...Common,
    purchaseId: IdSchema,
    sampleId: IdSchema,
    /** Model confidence 0..1 (a score, not money). */
    confidence: z.number().min(0).max(1),
  }),
  z.object({ type: z.literal("DISPUTE_WITHOUT_PROOF"), ...Common, purchaseId: IdSchema }),
  z.object({ type: z.literal("RECONCILIATION_DIFF"), ...Common, subject: z.string().min(1) }),
]);
export type RaiseExceptionInput = z.infer<typeof RaiseExceptionInputSchema>;

export const DecideExceptionInputSchema = z.object({
  decidedBy: z.string().min(1),
  decision: ExceptionDecisionSchema,
  reason: z.string().min(1).max(2000),
});
export type DecideExceptionInput = z.infer<typeof DecideExceptionInputSchema>;

export class SelfResolutionError extends Error {
  constructor(
    public readonly exceptionId: string,
    public readonly principal: string,
  ) {
    super(`${principal} raised exception ${exceptionId} and cannot decide it`);
    this.name = "SelfResolutionError";
  }
}
export class ExceptionAlreadyDecidedError extends Error {
  constructor(
    public readonly exceptionId: string,
    public readonly status: ExceptionStatus,
  ) {
    super(`exception ${exceptionId} is already ${status}`);
    this.name = "ExceptionAlreadyDecidedError";
  }
}
export class OnchainApprovalRequiredError extends Error {
  constructor(
    public readonly exceptionId: string,
    public readonly requestId: string | undefined,
  ) {
    super(
      `exception ${exceptionId} is approved by the controller in Coinbase Wallet; it closes when the indexer sees the treasury event` +
        (requestId ? ` (controller request ${requestId})` : ""),
    );
    this.name = "OnchainApprovalRequiredError";
  }
}

/** One open exception per subject. */
export function subjectFor(input: RaiseExceptionInput): string {
  switch (input.type) {
    case "NEW_PAYEE":
      return `payee:${input.payee.toLowerCase()}`;
    case "CAP_RAISE":
      return `node:${input.nodeId}:cap`;
    case "PAUSE_REQUEST":
      return `node:${input.nodeId}:pause`;
    case "UNCLEAR_LICENSE":
      return `resource:${input.resourceId}:license`;
    case "LOW_CONFIDENCE_SAMPLE":
      return `sample:${input.sampleId}`;
    case "DISPUTE_WITHOUT_PROOF":
      return `dispute:${input.purchaseId}`;
    case "RECONCILIATION_DIFF":
      return input.subject;
  }
}

function actionFor(input: RaiseExceptionInput): ControllerAction | undefined {
  switch (input.type) {
    case "NEW_PAYEE":
      return { kind: "set-allow", payee: input.payee, allowed: true };
    case "CAP_RAISE":
      return { kind: "raise-cap", nodeId: input.nodeId, newCapAtomic: input.newCapAtomic };
    case "PAUSE_REQUEST":
      return { kind: "pause", nodeId: input.nodeId };
    default:
      return undefined;
  }
}

/** Everything type-specific, plus the agent concerned (so later events can link to it). Columns of the row itself are left out. */
function detailsFor(input: RaiseExceptionInput): Record<string, unknown> {
  const { type: _t, requestedBy: _r, reason: _re, purchaseId: _p, amountAtomic: _m, ...rest } = input;
  return rest;
}

export interface RaiseResult {
  exception: ExceptionRecord;
  request?: ControllerRequest | undefined;
  /** False when an open exception for the same subject already existed and was returned instead. */
  created: boolean;
  events: ActivityEvent[];
}

export interface DecideResult {
  exception: ExceptionRecord;
  request?: ControllerRequest | undefined;
  events: ActivityEvent[];
}

export interface ExceptionContext {
  /** The treasury the owner calls target. Null until a deployments file is configured. */
  treasury: Address | null;
}

const link = (input: { purchaseId?: string | undefined; agentId?: string | undefined }) => ({
  ...(input.purchaseId ? { purchaseId: input.purchaseId } : {}),
  ...(input.agentId ? { agentId: input.agentId } : {}),
});

/** Opens the exception (and its request for onchain types) on the caller's executor. */
export async function raiseException(repos: Repositories, raw: RaiseExceptionInput, ctx: ExceptionContext): Promise<RaiseResult> {
  const input = RaiseExceptionInputSchema.parse(raw);
  const subject = subjectFor(input);
  const existing = await repos.exceptions.findOpenBySubject(input.type, subject);
  if (existing) {
    const [request] = await repos.controllerRequests.listByExceptionId(existing.id);
    return { exception: existing, request, created: false, events: [] };
  }
  const action = actionFor(input);
  if (action && !ctx.treasury) {
    throw new NotWiredError("treasury address for controller requests", "deployments/base-sepolia.json (BASE_SEPOLIA_RPC_URL)");
  }
  const exception = await repos.exceptions.open({
    type: input.type,
    reason: input.reason,
    subject,
    requestedBy: input.requestedBy,
    details: detailsFor(input),
    ...(input.amountAtomic ? { amountAtomic: input.amountAtomic } : {}),
    ...(input.purchaseId ? { purchaseId: input.purchaseId } : {}),
  });
  const events: ActivityEvent[] = [];
  events.push(
    await repos.activityEvents.insert({
      kind: "exception.opened",
      message: `${input.type} exception ${exception.id} raised by ${input.requestedBy}: ${input.reason}`,
      ...link(input),
      simulated: false,
    }),
  );
  let request: ControllerRequest | undefined;
  if (action && ctx.treasury) {
    const call = buildControllerCall(action, ctx.treasury);
    request = await repos.controllerRequests.insert({
      action,
      exceptionId: exception.id,
      requestedBy: input.requestedBy,
      reason: input.reason,
      ...call,
    });
    events.push(
      await repos.activityEvents.insert({
        kind: "controller.requested",
        message: `controller request ${request.id} prepared for exception ${exception.id}: ${call.summary}; awaiting approval in Coinbase Wallet`,
        ...link(input),
        simulated: false,
      }),
    );
  }
  return { exception, request, created: true, events };
}

/** The controller's offchain decision. Onchain types can only be rejected here; the chain approves them. */
export async function decideException(repos: Repositories, id: string, raw: DecideExceptionInput): Promise<DecideResult> {
  const input = DecideExceptionInputSchema.parse(raw);
  const exception = await repos.exceptions.getById(id);
  if (!exception) throw new NotFoundError("exceptions", id);
  if (exception.status !== "open") throw new ExceptionAlreadyDecidedError(id, exception.status);
  if (exception.requestedBy !== undefined && exception.requestedBy === input.decidedBy) {
    throw new SelfResolutionError(id, input.decidedBy);
  }
  const [pending] = (await repos.controllerRequests.listByExceptionId(id)).filter((r) => r.status === "pending");
  if (isOnchainExceptionType(exception.type) && input.decision === "approve") {
    throw new OnchainApprovalRequiredError(id, pending?.id);
  }
  const outcome = input.decision === "approve" ? "resolved" : "dismissed";
  const updated = await repos.exceptions.resolve(id, input.decidedBy, outcome, { decision: input.decision, decisionReason: input.reason });
  const request = pending ? await repos.controllerRequests.resolve(pending.id, "rejected") : undefined;
  const events: ActivityEvent[] = [
    await repos.activityEvents.insert({
      kind: "controller.resolved",
      message:
        `${exception.type} exception ${id} ${outcome} by ${input.decidedBy} (${input.decision}): ${input.reason}` +
        (request ? `; controller request ${request.id} rejected, no owner call will be made` : ""),
      ...link({ purchaseId: exception.purchaseId, agentId: agentIdOf(exception) }),
      simulated: false,
    }),
  ];
  return { exception: updated, request, events };
}

const agentIdOf = (e: ExceptionRecord): string | undefined => {
  const v = e.details?.["agentId"];
  return typeof v === "string" ? v : undefined;
};

/**
 * Called by the indexer handlers for AllowSet / CapRaised / NodePaused, inside
 * the per-log transaction. Every pending request the stored event matches
 * becomes done with that txHash and its exception is resolved by the chain.
 * This is the only code path that sets "done".
 */
export async function completeControllerRequests(
  repos: Repositories,
  log: { eventName: string; args: JsonArgs; txHash: Hex },
): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for (const pending of await repos.controllerRequests.listPending()) {
    if (!requestMatchesLog(pending, log.eventName, log.args)) continue;
    const request = await repos.controllerRequests.resolve(pending.id, "done", log.txHash);
    const argText = Object.entries(log.args)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(", ");
    const why = `${log.eventName}(${argText}) confirmed in ${log.txHash}`;
    let exception: ExceptionRecord | undefined;
    if (request.exceptionId) {
      const current = await repos.exceptions.getById(request.exceptionId);
      if (current && current.status === "open") {
        exception = await repos.exceptions.resolve(current.id, "chain", "resolved", { decision: "approve", decisionReason: why });
      } else {
        exception = current;
      }
    }
    events.push(
      await repos.activityEvents.insert({
        kind: "controller.resolved",
        message: `controller request ${request.id} done: ${why}` + (exception ? `; exception ${exception.id} resolved` : ""),
        txHash: log.txHash,
        ...(exception ? link({ purchaseId: exception.purchaseId, agentId: agentIdOf(exception) }) : {}),
        simulated: false,
      }),
    );
  }
  return events;
}

export interface ExceptionServiceDeps {
  db: Db;
  treasury: Address | null;
  bus?: ActivityBus | undefined;
}

export interface ExceptionService {
  raise(input: RaiseExceptionInput): Promise<RaiseResult>;
  decide(id: string, input: DecideExceptionInput): Promise<DecideResult>;
  list(status?: ExceptionStatus | "all"): Promise<Array<ExceptionRecord & { request: ControllerRequest | null }>>;
  listRequests(status?: ControllerRequestStatus | "all"): Promise<ControllerRequest[]>;
  readonly treasury: Address | null;
}

/** Transactional wrapper: one commit per call, activity published on the bus after it. */
export function createExceptionService(deps: ExceptionServiceDeps): ExceptionService {
  const publish = (events: ActivityEvent[]): void => {
    for (const ev of events) deps.bus?.publish(ev);
  };
  return {
    treasury: deps.treasury,
    async raise(input) {
      const r = await deps.db.transaction((tx) => raiseException(createRepositories(tx), input, { treasury: deps.treasury }));
      publish(r.events);
      return r;
    },
    async decide(id, input) {
      const r = await deps.db.transaction((tx) => decideException(createRepositories(tx), id, input));
      publish(r.events);
      return r;
    },
    async list(status = "open") {
      const repos = createRepositories(deps.db);
      const exceptions = await repos.exceptions.list(status);
      const requests = await repos.controllerRequests.list("all");
      const byException = new Map(requests.filter((r) => r.exceptionId).map((r) => [r.exceptionId!, r]));
      return exceptions.map((e) => ({ ...e, request: byException.get(e.id) ?? null }));
    },
    listRequests(status = "pending") {
      return createRepositories(deps.db).controllerRequests.list(status);
    },
  };
}
