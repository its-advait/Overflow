import type { AgentRecord, Organization } from "@overflow/schemas";
import type { Db } from "./client";
import { createRepositories } from "./repositories";

/**
 * SIMULATED: a fictional research firm for the demo (SPEC "Company and people").
 * Override the name with COMPANY_NAME. Departments match the spec's
 * research/finance split example.
 */
export const DEFAULT_COMPANY_NAME = "Larkspur Research Partners";
export const SEED_ORGANIZATION_ID = "org-demo";
export const SEED_DEPARTMENTS = ["research", "finance"] as const;

/**
 * SIMULATED placeholder keys: deterministic, not derived from any private key.
 * The service replaces them with real agent addresses when nodes are created.
 */
const PLACEHOLDER_KEYS = {
  orchestrator: "0x0000000000000000000000000000000000000A01",
  research: "0x0000000000000000000000000000000000000A02",
  finance: "0x0000000000000000000000000000000000000A03",
} as const;

export interface SeedOptions {
  companyName?: string | undefined;
  now?: string | undefined;
}

export interface SeedResult {
  organization: Organization;
  agents: AgentRecord[];
}

/** Idempotent: fixed ids, insert-if-missing. Safe to run on every boot. */
export async function seed(db: Db, opts: SeedOptions = {}): Promise<SeedResult> {
  const repos = createRepositories(db);
  const companyName = opts.companyName ?? process.env["COMPANY_NAME"] ?? DEFAULT_COMPANY_NAME;
  const now = opts.now ?? new Date().toISOString();

  const organization = await repos.organizations.upsertById({
    id: SEED_ORGANIZATION_ID,
    name: companyName,
    departments: [...SEED_DEPARTMENTS],
    simulated: true,
    createdAt: now,
  });

  const orchestrator = await repos.agents.upsertById({
    id: "agent-orchestrator",
    organizationId: organization.id,
    name: "Orchestrator",
    department: "research",
    role: "orchestrator",
    key: PLACEHOLDER_KEYS.orchestrator,
    createdAt: now,
  });
  const research = await repos.agents.upsertById({
    id: "agent-research",
    organizationId: organization.id,
    name: "Research analyst agent",
    department: "research",
    role: "analyst",
    key: PLACEHOLDER_KEYS.research,
    parentAgentId: orchestrator.id,
    createdAt: now,
  });
  const finance = await repos.agents.upsertById({
    id: "agent-finance",
    organizationId: organization.id,
    name: "Finance analyst agent",
    department: "finance",
    role: "analyst",
    key: PLACEHOLDER_KEYS.finance,
    parentAgentId: orchestrator.id,
    createdAt: now,
  });

  return { organization, agents: [orchestrator, research, finance] };
}
