import {
  AtomicAmountSchema,
  IdSchema,
  MissionRecordSchema,
  PurchaseGroupSchema,
  PurchaseRecordSchema,
  ResourceRequestRecordSchema,
} from "@overflow/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { ApiError, parseBody, parseParams, respond, type ApiEnv } from "../http.js";

const CreateMissionBody = z.object({
  goal: z.string().min(1).max(2000),
  /** Integer atomic USDC (6 decimals). The UI converts with toAtomic(); never a float. */
  budgetAtomic: AtomicAmountSchema,
  /** Treasury node that pays. Defaults to the organization's orchestrator node. */
  rootNodeId: z.number().int().positive().optional(),
  ownerAgentId: IdSchema.optional(),
});

const MissionResponse = z.object({ mission: MissionRecordSchema });
const MissionsResponse = z.object({ missions: z.array(MissionRecordSchema) });
/** Read model for the Purchases page: the mission, its requests, its purchases and the Fusion groups behind merged ones. */
const MissionDetailResponse = z.object({
  mission: MissionRecordSchema,
  requests: z.array(ResourceRequestRecordSchema),
  purchases: z.array(PurchaseRecordSchema),
  groups: z.array(PurchaseGroupSchema),
});
const PlanResponse = z.object({ mission: MissionRecordSchema, requests: z.array(ResourceRequestRecordSchema) });
const IdParams = z.object({ id: IdSchema });
const RunBody = z.object({
  /** DEMO_MODE only: replay the injected /premium-intel attempt as a labeled SIMULATED step if the live model declined it. */
  forceInjectionBeat: z.boolean().default(false),
});
const RunResponse = z.object({ mission: MissionRecordSchema, runId: IdSchema, note: z.string() });
const PauseAgentParams = z.object({ id: IdSchema, agentId: IdSchema });
const PauseAgentResponse = z.object({ txHash: z.string(), nodeId: z.number().int(), agentId: IdSchema });

export function missionRoutes(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();

  app.get("/", async (c) => {
    const missions = await deps.repos.missions.listByOrganization(c.get("session").organizationId);
    return respond(c, MissionsResponse, { missions });
  });

  /** Everything stored for one mission. Oracle decisions and Fusion rule checks are not stored; they come from POST /api/purchases/propose. */
  app.get("/:id", async (c) => {
    const { id } = parseParams(c, IdParams);
    const mission = await loadMission(deps, c.get("session").organizationId, id);
    const [requests, purchases, groups] = await Promise.all([
      deps.repos.resourceRequests.listByMission(id),
      deps.repos.purchases.listByMission(id),
      deps.repos.purchaseGroups.listByMission(id),
    ]);
    return respond(c, MissionDetailResponse, { mission, requests, purchases, groups });
  });

  app.post("/", async (c) => {
    const body = await parseBody(c, CreateMissionBody);
    const session = c.get("session");

    let rootNodeId = body.rootNodeId;
    if (rootNodeId === undefined) {
      const agents = await deps.repos.agents.listByOrganization(session.organizationId);
      const orchestrator = agents.find((a) => a.role === "orchestrator");
      if (!orchestrator?.nodeId) {
        throw new ApiError(
          409,
          "no_root_node",
          "no treasury root node is registered for this organization yet; pass rootNodeId or create the root onchain first",
        );
      }
      rootNodeId = orchestrator.nodeId;
    }
    if (body.ownerAgentId) {
      const owner = await deps.repos.agents.getById(body.ownerAgentId);
      if (!owner || owner.organizationId !== session.organizationId) {
        throw new ApiError(404, "not_found", `agent ${body.ownerAgentId} not found in this organization`);
      }
    }

    const mission = await deps.repos.missions.insert({
      organizationId: session.organizationId,
      goal: body.goal,
      budgetAtomic: body.budgetAtomic,
      rootNodeId,
      ...(body.ownerAgentId ? { ownerAgentId: body.ownerAgentId } : {}),
      status: "draft",
    });
    await deps.repos.activityEvents.insert({
      kind: "mission.created",
      message: `mission created: ${mission.goal} (budget ${mission.budgetAtomic} atomic USDC)`,
      missionId: mission.id,
      ...(mission.ownerAgentId ? { agentId: mission.ownerAgentId } : {}),
    });
    return respond(c, MissionResponse, { mission }, 201);
  });

  app.post("/:id/plan", async (c) => {
    const { id } = parseParams(c, IdParams);
    const mission = await loadMission(deps, c.get("session").organizationId, id);
    // Oracle extracts and persists the requests (orchestration/oracle-port.ts); 503 when no model is configured.
    const requests = await deps.ports.orchestration.planMission(mission);
    const updated = (await deps.repos.missions.setStatus(mission.id, "planning")) ?? mission;
    return respond(c, PlanResponse, { mission: updated, requests });
  });

  // The orchestrator delegates to three sub-agents by signature and runs them. 202: the run continues in the
  // background and every step is an activity event (GET /api/activity?missionId=, /events). Nothing here pays.
  app.post("/:id/run", async (c) => {
    const { id } = parseParams(c, IdParams);
    const body = await parseBody(c, RunBody.partial().optional()).catch(() => ({ forceInjectionBeat: false }));
    const mission = await loadMission(deps, c.get("session").organizationId, id);
    const { runId, done } = await deps.ports.orchestration.runMission(mission, { forceInjectionBeat: body?.forceInjectionBeat ?? false });
    void done.catch(() => undefined); // failures are written as mission.run events by the runner
    const updated = (await deps.repos.missions.getById(mission.id)) ?? mission;
    return respond(c, RunResponse, { mission: updated, runId, note: "run accepted; follow GET /api/activity?missionId= or /events" }, 202);
  });

  app.post("/:id/agents/:agentId/pause", async (c) => {
    const { id, agentId } = parseParams(c, PauseAgentParams);
    const mission = await loadMission(deps, c.get("session").organizationId, id);
    const result = await deps.ports.orchestration.pauseAgent(mission, agentId);
    return respond(c, PauseAgentResponse, { ...result, agentId });
  });

  return app;
}

export async function loadMission(deps: ApiDeps, organizationId: string, id: string) {
  const mission = await deps.repos.missions.getById(id);
  if (!mission || mission.organizationId !== organizationId) {
    throw new ApiError(404, "not_found", `mission ${id} not found`);
  }
  return mission;
}
