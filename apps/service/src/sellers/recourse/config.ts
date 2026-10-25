import type { Hex } from "@overflow/schemas";
import { encodePacked, keccak256 } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";
import { SellerBehaviorSchema, type SellerBehavior } from "./protocol.js";

// ---------------------------------------------------------------------------
// SIMULATED Recourse seller configuration. SELLER_KEYS[0] backs sim-seller-a and
// SELLER_KEYS[1] backs sim-seller-b (falling back to [0]); two seller ids may
// therefore share one address, so the caller builds ONE relayer/chain per
// address, never per seller id (one nonce manager per key).
// ---------------------------------------------------------------------------

export const RECOURSE_SELLER_IDS = ["sim-seller-a", "sim-seller-b"] as const;
export const SELLER_SECRET_DOMAIN = "overflow.simulated.recourse.seller-secret";

const PrivateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte private key");
const IntString = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const EnvSchema = z.object({
  SELLER_KEYS: z.string().optional(),
  /** "sim-seller-a=honest,sim-seller-b=ghost"; default honest for every seller. */
  SELLER_BEHAVIORS: z.string().optional(),
  RECOURSE_BOND_BPS: IntString(0, 10_000).default(2000),
  RECOURSE_REVEAL_WINDOW_S: IntString(1, 86_400).default(600),
  RECOURSE_CHALLENGE_WINDOW_S: IntString(1, 86_400).default(120),
  /** Optional swapped-chunk index override for the `swap` behavior (tests/demos). */
  RECOURSE_SWAP_INDEX: IntString(0, 2 ** 31 - 1).optional(),
});

export interface RecourseSellerKey {
  sellerId: string;
  account: PrivateKeyAccount;
  /** Derived from the private key; never leaves the process. */
  sellerSecret: Hex;
}

export interface RecourseConfig {
  sellers: Map<string, RecourseSellerKey>;
  behaviors: Map<string, SellerBehavior>;
  bondBps: number;
  revealWindowS: number;
  challengeWindowS: number;
  swapIndex: number | null;
}

export type RecourseConfigResult = { ok: true; config: RecourseConfig } | { ok: false; reason: string };

export class RecourseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecourseConfigError";
  }
}

function compact(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "") out[k] = v;
  return out;
}

export function deriveSellerSecret(privateKey: Hex): Hex {
  return keccak256(encodePacked(["bytes32", "string"], [privateKey, SELLER_SECRET_DOMAIN]));
}

export function parseBehaviors(spec: string | undefined, sellerIds: readonly string[]): Map<string, SellerBehavior> {
  const out = new Map<string, SellerBehavior>(sellerIds.map((id) => [id, "honest" as const]));
  for (const part of (spec ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [id, raw] = part.split("=").map((p) => p.trim());
    if (!id || raw === undefined) throw new RecourseConfigError(`SELLER_BEHAVIORS: expected <sellerId>=<behavior>, got "${part}"`);
    const parsed = SellerBehaviorSchema.safeParse(raw);
    if (!parsed.success) throw new RecourseConfigError(`SELLER_BEHAVIORS: unknown behavior "${raw}" for ${id} (honest|swap|ghost)`);
    if (!sellerIds.includes(id)) throw new RecourseConfigError(`SELLER_BEHAVIORS: unknown seller id "${id}"`);
    out.set(id, parsed.data);
  }
  return out;
}

/** Returns `{ ok: false }` only when SELLER_KEYS is empty (the service logs idle); invalid values throw. */
export function resolveRecourseConfig(env: NodeJS.ProcessEnv = process.env): RecourseConfigResult {
  const parsed = EnvSchema.safeParse(compact(env));
  if (!parsed.success) {
    throw new RecourseConfigError(`invalid recourse env: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  const e = parsed.data;
  const keys = (e.SELLER_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return { ok: false, reason: "SELLER_KEYS is empty: SIMULATED Recourse sellers idle" };
  const privateKeys = keys.map((k) => PrivateKey.parse(k) as Hex);

  const sellers = new Map<string, RecourseSellerKey>();
  RECOURSE_SELLER_IDS.forEach((sellerId, i) => {
    const pk = privateKeys[i] ?? privateKeys[0]!;
    sellers.set(sellerId, { sellerId, account: privateKeyToAccount(pk), sellerSecret: deriveSellerSecret(pk) });
  });

  return {
    ok: true,
    config: {
      sellers,
      behaviors: parseBehaviors(e.SELLER_BEHAVIORS, RECOURSE_SELLER_IDS),
      bondBps: e.RECOURSE_BOND_BPS,
      revealWindowS: e.RECOURSE_REVEAL_WINDOW_S,
      challengeWindowS: e.RECOURSE_CHALLENGE_WINDOW_S,
      swapIndex: e.RECOURSE_SWAP_INDEX ?? null,
    },
  };
}
