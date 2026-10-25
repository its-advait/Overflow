import { createRepositories, type Db } from "@overflow/database";
import { allocate, checkMerge, fuse, MergeDecisionSchema, payingNode, type AgentTreeNode, type MergeDecision } from "@overflow/fusion";
import {
  coverageRejections,
  extractRequirements,
  loadOwnedResources,
  recommend,
  skipOwned,
  termsRejections,
  type ExtractionClient,
  type Explanation,
} from "@overflow/oracle";
import {
  atomicToBigInt,
  IdSchema,
  USDC,
  type Address,
  type AgentRecord,
  type Hex,
  type MissionRecord,
  type ResourceRecord,
  type ResourceRequestRecord,
} from "@overflow/schemas";
import { z } from "zod";
import { NotWiredError, type OrchestrationPort } from "../api/ports.js";
import type { ProposeInput } from "./purchase-service.js";

// ---------------------------------------------------------------------------
// OrchestrationPort backed by @overflow/oracle.
//
// planMission: the model proposes requirements (extractRequirements), code
// validates and persists them as resource_requests. Re-planning withdraws the
// mission's earlier open requests so a mission never carries two generations.
//
// propose: for every open request, recommend() (pure code: skipOwned ->
// coverage -> terms -> rank -> explain) picks a listing from the resources
// table. The decision is recorded as an `oracle.recommendation` event; it
// authorizes nothing. The chain fields of the resulting PurchaseOrder (seller,
// escrow address, termsHash, orderId) belong to the seller's order (SPEC "One
// purchase, end to end", step 3), so they come from an OrderTermsPort; nothing
// here invents an address.
//
// Fusion (@overflow/fusion) then merges compatible requests: stage 1 pairs
// topics, stage 2 checks the nine merge rules against the listings every
// member could share (coverage, freshness and license per request; price is
// judged on the combined caps). A merged purchase is paid by the agents'
// lowest common ancestor and split into exact allocations weighted by each
// agent's max price. Requests that chose the same listing but cannot share it
// (e.g. one seat) yield one purchase for the lowest-id request; the others
// stay open, because one (mission, resource) has one active purchase.
// ---------------------------------------------------------------------------

export interface OracleModel {
  client: ExtractionClient;
  /** From CLAUDE_MODEL; never hardcoded. */
  model: string;
}

export interface OrderTermsInput {
  mission: MissionRecord;
  resource: ResourceRecord;
  amountAtomic: string;
  buyerTreasury: Address;
  /** The resource_requests this order satisfies. */
  requestIds: string[];
}

export interface OrderTerms {
  sellerAddress: Address;
  /** factory.predict(orderId, termsHash): the escrow is the order. */
  escrowAddress: Address;
  termsHash: Hex;
  orderIdBytes32: Hex;
  authorizationExpiresAt: string;
  /** True when the terms came from a simulated seller. */
  simulated: boolean;
}

/** Spec step 3: the seller's order fixes seller, escrow, termsHash and orderId. Implemented by the Recourse seller client. */
export interface OrderTermsPort {
  prepare(input: OrderTermsInput): Promise<OrderTerms>;
}

export function notWiredOrderTerms(): OrderTermsPort {
  return {
    prepare: async () => {
      throw new NotWiredError("OrderTermsPort.prepare (Recourse seller POST /orders)", "P7.x");
    },
  };
}

export class OracleUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`Oracle model unavailable: ${reason}`);
    this.name = "OracleUnavailableError";
  }
}

export class NoOpenRequestsError extends Error {
  constructor(public readonly missionId: string) {
    super(`mission ${missionId} has no open resource requests; run POST /api/missions/${missionId}/plan first`);
    this.name = "NoOpenRequestsError";
  }
}

export const OracleDecisionSchema = z.object({
  requestId: IdSchema,
  /** Listing (resource id) the deterministic pipeline ranked first; null when every listing was rejected. */
  chosen: IdSchema.nullable(),
  /** Remaining ranked survivors, in rank order. */
  alternatives: z.array(IdSchema),
  rejected: z.array(
    z.object({
      listingId: IdSchema,
      reasons: z.array(z.object({ reason: z.string().min(1), detail: z.string().min(1) })),
    }),
  ),
  assumptions: z.array(z.string()),
  /** Ends with "This is a recommendation; it authorizes no payment." */
  summary: z.string().min(1),
  simulated: z.boolean(),
});
export type OracleDecision = z.infer<typeof OracleDecisionSchema>;

export const PayerSchema = z.object({
  agentId: IdSchema.nullable(),
  nodeId: z.number().int().positive(),
  rule: z.enum(["lca", "lca-ancestor-with-node", "mission-root"]),
  evidence: z.string().min(1),
});

/** A Fusion decision as returned by propose: the rule checks plus who pays and who waits. It authorizes no payment. */
export const FusionOutcomeSchema = MergeDecisionSchema.extend({
  /** The paying node of the resulting purchase; null when the decision produced no shared purchase. */
  payer: PayerSchema.nullable(),
  /** Requests left open: they chose the same listing but cannot share it, and one active purchase per (mission, resource) already exists. */
  waitingRequestIds: z.array(IdSchema),
});
export type FusionOutcome = z.infer<typeof FusionOutcomeSchema>;

export interface ProposeResult {
  proposals: ProposeInput[];
  decisions: OracleDecision[];
  merges: FusionOutcome[];
}

export interface OraclePortOptions {
  db: Db;
  /** null: planMission answers 503 (CLAUDE_MODEL / ANTHROPIC_API_KEY unset). propose needs no model. */
  model: OracleModel | null;
  /** The deployed treasury (buyer). null: propose answers 501; no address is invented. */
  treasury: Address | null;
  orderTerms: OrderTermsPort;
  now?: (() => Date) | undefined;
}

function decisionOf(requestId: string, explanation: Explanation): OracleDecision {
  return OracleDecisionSchema.parse({
    requestId,
    chosen: explanation.chosen?.listingId ?? null,
    alternatives: explanation.alternatives.map((a) => a.listing.id),
    rejected: explanation.rejected.map((r) => ({
      listingId: r.listingId,
      reasons: r.reasons.map((x) => ({ reason: x.reason, detail: x.detail })),
    })),
    assumptions: [...explanation.assumptions],
    summary: explanation.summary,
    simulated: explanation.simulated,
  });
}

export function createOraclePort(opts: OraclePortOptions): OrchestrationPort {
  const now = opts.now ?? (() => new Date());

  async function requesterAgentId(mission: MissionRecord): Promise<string> {
    const repos = createRepositories(opts.db);
    if (mission.ownerAgentId) return mission.ownerAgentId;
    const agents = await repos.agents.listByOrganization(mission.organizationId);
    const orchestrator = agents.find((a) => a.role === "orchestrator");
    if (!orchestrator) throw new Error(`organization ${mission.organizationId} has no orchestrator agent to own the mission's requests`);
    return orchestrator.id;
  }

  return {
    async planMission(mission: MissionRecord): Promise<ResourceRequestRecord[]> {
      if (!opts.model) throw new OracleUnavailableError("CLAUDE_MODEL and ANTHROPIC_API_KEY must be set for requirement extraction");
      const repos = createRepositories(opts.db);
      const listings = await repos.resources.list();
      const knownRegions = [...new Set(listings.flatMap((l) => l.coverage.regions))].sort();
      const agentId = await requesterAgentId(mission);

      const result = await extractRequirements(
        { mission, knownRegions, now: now() },
        { client: opts.model.client, model: opts.model.model, audit: repos.activityEvents },
      );

      return opts.db.transaction(async (tx) => {
        const txRepos = createRepositories(tx);
        for (const previous of await txRepos.resourceRequests.listByMission(mission.id)) {
          if (previous.status === "open") await txRepos.resourceRequests.setStatus(previous.id, "withdrawn");
        }
        const inserted: ResourceRequestRecord[] = [];
        for (const request of result.requests) {
          inserted.push(await txRepos.resourceRequests.insert({ ...request, missionId: mission.id, agentId }));
        }
        return inserted;
      });
    },

    async propose(mission: MissionRecord): Promise<ProposeResult> {
      const repos = createRepositories(opts.db);
      const open = (await repos.resourceRequests.listByMission(mission.id)).filter((r) => r.status === "open");
      if (open.length === 0) throw new NoOpenRequestsError(mission.id);

      const listings = await repos.resources.list();
      const owned = await loadOwnedResources(repos, mission.organizationId);
      const agents = await repos.agents.listByOrganization(mission.organizationId);
      const at = now();

      // 1. Oracle per request: what it would buy alone, and what it could share.
      const decisions: OracleDecision[] = [];
      const requestById = new Map(open.map((r) => [r.id, r]));
      const summaries = new Map<string, string>();
      const standalone = new Map<string, ResourceRecord | undefined>();
      const shareable = new Map<string, ResourceRecord[]>();
      const notOwned = skipOwned(listings, owned).kept;
      for (const request of open) {
        const rec = recommend({ request, listings, owned, now: at });
        const decision = decisionOf(request.id, rec.explanation);
        decisions.push(decision);
        summaries.set(request.id, decision.summary);
        standalone.set(request.id, decision.chosen ? listings.find((l) => l.id === decision.chosen) : undefined);
        // Fusion candidates: pass coverage, freshness and license for this request; the price cap is judged on the merged caps.
        shareable.set(
          request.id,
          notOwned.filter((l) => coverageRejections(request, l).length === 0 && termsRejections(request, l, at).every((r) => r.reason === "price")),
        );
        const rejectedText = decision.rejected.map((r) => `${r.listingId}: ${r.reasons.map((x) => x.reason).join(",")}`).join("; ");
        await repos.activityEvents.insert({
          kind: "oracle.recommendation",
          message:
            `request ${request.id}: ${decision.chosen ? `chose ${decision.chosen}` : "no listing qualifies"}` +
            (rejectedText ? ` (rejected ${rejectedText})` : "") +
            `. ${decision.summary}`,
          missionId: mission.id,
          agentId: request.agentId,
          simulated: decision.simulated,
        });
      }

      // 2. Fusion: one plan per resource. A plan carries the requests it serves, the decision that formed it and the requests left waiting.
      interface Plan {
        resource: ResourceRecord;
        requests: ResourceRequestRecord[];
        decision: MergeDecision | null;
        waiting: string[];
      }
      const plans = new Map<string, Plan>();
      const informational: MergeDecision[] = [];
      const sortById = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const addToPlan = (resource: ResourceRecord, requests: ResourceRequestRecord[], decision: MergeDecision | null): void => {
        const existing = plans.get(resource.id);
        if (!existing) {
          plans.set(resource.id, { resource, requests: [...requests].sort(sortById), decision, waiting: [] });
          return;
        }
        // Two plans for one resource would be two active purchases of one (mission, resource): stage 2 decides whether all can share it.
        const union = [...existing.requests, ...requests].sort(sortById);
        const d = checkMerge({ listing: resource, requests: union, standalone, now: at });
        if (d.merge) {
          plans.set(resource.id, { resource, requests: union, decision: d, waiting: existing.waiting });
        } else {
          existing.decision = d;
          existing.waiting = [...existing.waiting, ...requests.map((r) => r.id)].sort();
        }
      };

      const fused = fuse({ requests: open, survivors: shareable, standalone, now: at });
      for (const d of fused.merges) {
        const resource = d.listingId ? listings.find((l) => l.id === d.listingId) : undefined;
        if (d.merge && resource) addToPlan(resource, d.requestIds.map((id) => requestById.get(id)!), d);
        else informational.push(d);
      }
      const unmergedByResource = new Map<string, ResourceRequestRecord[]>();
      for (const request of open) {
        if (fused.mergedRequestIds.has(request.id)) continue;
        const chosen = standalone.get(request.id);
        if (!chosen) continue;
        unmergedByResource.set(chosen.id, [...(unmergedByResource.get(chosen.id) ?? []), request]);
      }
      for (const resourceId of [...unmergedByResource.keys()].sort()) {
        const requests = unmergedByResource.get(resourceId)!.sort(sortById);
        const resource = listings.find((l) => l.id === resourceId)!;
        if (requests.length === 1 || plans.has(resourceId)) {
          addToPlan(resource, requests, null);
          continue;
        }
        const d = checkMerge({ listing: resource, requests, standalone, now: at });
        if (d.merge) addToPlan(resource, requests, d);
        else plans.set(resourceId, { resource, requests: [requests[0]!], decision: d, waiting: requests.slice(1).map((r) => r.id) });
      }

      // 3. Record every Fusion decision (it authorizes nothing), merged or not.
      const merges: FusionOutcome[] = [];
      const tree: AgentTreeNode[] = agents.map((a) => ({ id: a.id, parentAgentId: a.parentAgentId, nodeId: a.nodeId }));
      const agentById = new Map<string, AgentRecord>(agents.map((a) => [a.id, a]));
      const orderedPlans = [...plans.values()].sort((a, b) => (a.resource.id < b.resource.id ? -1 : 1));
      const payers = new Map<string, ReturnType<typeof payingNode>>();
      for (const plan of orderedPlans) {
        const agentIds = [...new Set(plan.requests.map((r) => r.agentId))].sort();
        const payer = payingNode(agentIds, tree, mission.rootNodeId);
        payers.set(plan.resource.id, payer);
        if (!plan.decision) continue;
        const waitingNote = plan.waiting.length
          ? ` Request(s) ${plan.waiting.join(", ")} wait: ${plan.resource.id} cannot be shared and one active purchase per mission and resource exists; a second seat needs its own order once this one settles.`
          : "";
        merges.push(FusionOutcomeSchema.parse({ ...plan.decision, payer, waitingRequestIds: plan.waiting }));
        await repos.activityEvents.insert({
          kind: "fusion.decision",
          message: `${plan.decision.reason}. ${payer.evidence}.${waitingNote}`,
          missionId: mission.id,
          agentId: plan.requests[0]!.agentId,
          simulated: plan.decision.simulated,
        });
      }
      for (const d of informational) {
        merges.push(FusionOutcomeSchema.parse({ ...d, payer: null, waitingRequestIds: [] }));
        await repos.activityEvents.insert({
          kind: "fusion.decision",
          message: `${d.reason}. Requests stay separate.`,
          missionId: mission.id,
          agentId: requestById.get(d.requestIds[0]!)?.agentId,
          simulated: d.simulated,
        });
      }

      if (orderedPlans.length === 0) return { proposals: [], decisions, merges };
      if (!opts.treasury) throw new NotWiredError("buyer treasury address (deployments/base-sepolia.json)", "deploy script, P1.2");
      const treasury = opts.treasury;

      // 4. One proposal per plan: the seller's terms, the LCA payer, exact allocations weighted by each agent's cap.
      const proposals: ProposeInput[] = [];
      for (const plan of orderedPlans) {
        const { resource, requests } = plan;
        const requestIds = requests.map((r) => r.id).sort();
        const terms = await opts.orderTerms.prepare({
          mission,
          resource,
          amountAtomic: resource.priceAtomic,
          buyerTreasury: treasury,
          requestIds,
        });
        const participatingAgentIds = [...new Set(requests.map((r) => r.agentId))].sort();
        const payer = payers.get(resource.id)!;
        const weights = new Map<string, bigint>();
        for (const r of requests) weights.set(r.agentId, (weights.get(r.agentId) ?? 0n) + atomicToBigInt(r.maxPriceAtomic));
        const allocations = allocate(
          resource.priceAtomic,
          participatingAgentIds.map((agentId) => {
            const agent = agentById.get(agentId);
            if (!agent) throw new Error(`request agent ${agentId} is not in organization ${mission.organizationId}`);
            return { agentId, department: agent.department, weight: weights.get(agentId)! };
          }),
        );
        const summaryOwner = requests.find((r) => standalone.get(r.id)?.id === resource.id) ?? requests[0]!;
        const oracleReason = summaries.get(summaryOwner.id)!;
        const reason = plan.decision ? `${plan.decision.reason}. ${payer.evidence}` : oracleReason;
        proposals.push({
          purchase: {
            idempotencyKey: `propose:${mission.id}:${resource.id}:${requestIds.join(",")}`,
            orderIdBytes32: terms.orderIdBytes32,
            missionId: mission.id,
            resourceId: resource.id,
            buyerTreasury: treasury,
            sellerAddress: terms.sellerAddress,
            escrowAddress: terms.escrowAddress,
            chainId: 84532,
            tokenAddress: USDC.address,
            amountAtomic: resource.priceAtomic,
            payingNodeId: payer.nodeId,
            participatingAgentIds,
            allocations,
            resourceManifestHash: resource.manifestHash,
            termsHash: terms.termsHash,
            paymentPath: "overflow-facilitator",
            authorizationExpiresAt: terms.authorizationExpiresAt,
            oracleReason,
          },
          ...(requests.length > 1 ? { group: { payingNodeId: payer.nodeId, requestIds, mergeReason: reason } } : {}),
          reason,
          source: { kind: "oracle", reference: requestIds.join(",") },
          agentId: participatingAgentIds[0],
          simulated: resource.simulated || terms.simulated,
        });
      }
      return { proposals, decisions, merges };
    },
  };
}

/** GET / module line; says what is wired instead of claiming readiness. */
export function orchestrationStatus(w: { model: string | null; treasury: Address | null; orderTermsWired: boolean }): string {
  return [
    "purchase state machine ready",
    w.model ? `Oracle extraction via ${w.model}` : "Oracle extraction idle: CLAUDE_MODEL / ANTHROPIC_API_KEY unset (plan answers 503)",
    "Oracle recommend over the resources table",
    w.treasury ? `buyer treasury ${w.treasury}` : "no treasury address (propose answers 501 once a listing is chosen)",
    w.orderTermsWired ? "order terms from the seller" : "order terms not wired (propose answers 501 until the Recourse seller lands)",
    "Fusion: compatibility matcher, LCA payer, allocations",
  ].join("; ");
}
