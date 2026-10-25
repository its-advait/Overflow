import { createRepositories, type Db } from "@overflow/database";
import {
  extractRequirements,
  loadOwnedResources,
  recommend,
  type ExtractionClient,
  type Explanation,
} from "@overflow/oracle";
import {
  IdSchema,
  USDC,
  type Address,
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
// here invents an address. Fusion (P6.2) will merge requests and fill
// allocations; until then allocations stay empty and requests that chose the
// same resource share one proposal (one active purchase per mission+resource).
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

export interface ProposeResult {
  proposals: ProposeInput[];
  decisions: OracleDecision[];
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
      const at = now();

      const decisions: OracleDecision[] = [];
      const byResource = new Map<string, { resource: ResourceRecord; requests: ResourceRequestRecord[]; summaries: string[] }>();
      for (const request of open) {
        const rec = recommend({ request, listings, owned, now: at });
        const decision = decisionOf(request.id, rec.explanation);
        decisions.push(decision);
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
        if (!decision.chosen) continue;
        const resource = listings.find((l) => l.id === decision.chosen);
        if (!resource) continue;
        const group = byResource.get(resource.id) ?? { resource, requests: [], summaries: [] };
        group.requests.push(request);
        group.summaries.push(decision.summary);
        byResource.set(resource.id, group);
      }

      if (byResource.size === 0) return { proposals: [], decisions };
      if (!opts.treasury) throw new NotWiredError("buyer treasury address (deployments/base-sepolia.json)", "deploy script, P1.2");
      const treasury = opts.treasury;

      const proposals: ProposeInput[] = [];
      for (const { resource, requests, summaries } of byResource.values()) {
        const requestIds = requests.map((r) => r.id).sort();
        const terms = await opts.orderTerms.prepare({
          mission,
          resource,
          amountAtomic: resource.priceAtomic,
          buyerTreasury: treasury,
          requestIds,
        });
        const participatingAgentIds = [...new Set(requests.map((r) => r.agentId))];
        const reason = summaries[0]!;
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
            payingNodeId: mission.rootNodeId,
            participatingAgentIds,
            // Fusion (P6.2) fills allocations; an empty list is a whole, unsplit purchase.
            allocations: [],
            resourceManifestHash: resource.manifestHash,
            termsHash: terms.termsHash,
            paymentPath: "overflow-facilitator",
            authorizationExpiresAt: terms.authorizationExpiresAt,
            oracleReason: reason,
          },
          reason,
          source: { kind: "oracle", reference: requestIds.join(",") },
          agentId: participatingAgentIds[0],
          simulated: resource.simulated || terms.simulated,
        });
      }
      return { proposals, decisions };
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
    "Fusion lands at P6.2",
  ].join("; ");
}
