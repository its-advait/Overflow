import { resolveSigner } from "@overflow/payment-client/keystore";
import type { PrivateKeyAccount } from "viem/accounts";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { z } from "zod";
import { ROLES, type Role } from "./delegation-plan.js";

/**
 * DEMO LIMITATION: agent node keys live in the environment (AGENT_ROOT_KEY or a Foundry keystore for the
 * orchestrator; AGENT_KEYS for the three sub-agents). They sign EIP-712 messages only (CreateChild, PauseChild,
 * TransferWithAuthorization) and never send transactions or hold funds. P7.4 may replace them with CDP server
 * wallets so no raw private key exists in the service. Keys are never logged.
 */
export const AGENT_KEYS_LIMITATION =
  "agent node keys are env-held for the demo (AGENT_ROOT_KEY / AGENT_KEYS); P7.4 may swap them for CDP server wallets";

const Key64 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x 64-hex private key");

const EnvSchema = z.object({
  AGENT_ROOT_KEY: z.string().optional(),
  AGENT_ROOT_ACCOUNT: z.string().optional(),
  AGENT_ROOT_PASSWORD_FILE: z.string().optional(),
  /** Comma-separated 64-hex keys, in role order: research, finance, verification. */
  AGENT_KEYS: z.string().optional(),
});

export type AgentKeys = { root: PrivateKeyAccount; rootSource: string; children: Record<Role, PrivateKeyAccount> };

export type AgentKeysResolution = { ok: true; keys: AgentKeys } | { ok: false; reason: string };

/** Never throws; the service boots without a runner and says why. */
export function resolveAgentKeys(env: NodeJS.ProcessEnv = process.env): AgentKeysResolution {
  const e = EnvSchema.parse(env);
  const rootSlot = (e.AGENT_ROOT_KEY ?? "").trim();
  if (!rootSlot && !(e.AGENT_ROOT_ACCOUNT && e.AGENT_ROOT_PASSWORD_FILE)) {
    return { ok: false, reason: "AGENT_ROOT_KEY (or AGENT_ROOT_ACCOUNT + AGENT_ROOT_PASSWORD_FILE) unset" };
  }
  const raw = (e.AGENT_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (raw.length < ROLES.length) {
    return { ok: false, reason: `AGENT_KEYS needs ${ROLES.length} comma-separated keys (research, finance, verification), got ${raw.length}` };
  }
  const parsed = z.array(Key64).safeParse(raw.slice(0, ROLES.length));
  if (!parsed.success) return { ok: false, reason: `AGENT_KEYS: ${parsed.error.issues[0]?.message ?? "invalid key"}` };
  try {
    const root = resolveSigner({ keyOrAddress: rootSlot, account: e.AGENT_ROOT_ACCOUNT, passwordFile: e.AGENT_ROOT_PASSWORD_FILE, label: "AGENT_ROOT" });
    const children = Object.fromEntries(ROLES.map((role, i) => [role, privateKeyToAccount(parsed.data[i] as Hex)])) as Record<Role, PrivateKeyAccount>;
    const addresses = new Set([root.account.address.toLowerCase(), ...Object.values(children).map((c) => c.address.toLowerCase())]);
    if (addresses.size !== ROLES.length + 1) return { ok: false, reason: "agent keys must be distinct (the treasury rejects a key already in use)" };
    return { ok: true, keys: { root: root.account, rootSource: root.source, children } };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
