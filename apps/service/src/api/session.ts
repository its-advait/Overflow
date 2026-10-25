import { SEED_ORGANIZATION_ID } from "@overflow/database";
import { AddressSchema, type Address } from "@overflow/schemas";

/**
 * Demo session: one organization, one owner, no credentials. Every query is
 * scoped to `organizationId`. The owner never acts through this API directly:
 * owner-changing actions (pause, raise cap, allowlist) only create
 * ControllerRequests, and their txHash is set once the Coinbase Wallet
 * approval is confirmed onchain (P4.5).
 */
export interface Session {
  organizationId: string;
  /** Recorded as ControllerRequest.requestedBy. */
  principal: string;
  ownerAddress: Address | null;
}

export function resolveSession(env: NodeJS.ProcessEnv = process.env): Session {
  const owner = env["OWNER_ADDRESS"];
  const parsed = owner ? AddressSchema.safeParse(owner) : undefined;
  return {
    organizationId: env["OVERFLOW_ORG_ID"] || SEED_ORGANIZATION_ID,
    principal: "owner",
    ownerAddress: parsed?.success ? parsed.data : null,
  };
}
