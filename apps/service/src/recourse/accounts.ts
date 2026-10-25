import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "@overflow/schemas";

// ---------------------------------------------------------------------------
// Keys for the local recourse run, all from env (never hardcoded here):
//   AGENT_ROOT_KEY        the treasury root node key: signs TransferWithAuthorization and Accept(orderId)
//   RECOURSE_SELLER_KEYS  three comma-separated keys for the SIMULATED sellers; by position they default to the
//                         honest, ghost and swap behaviours (a judge may change each one live, recourse/behaviour.ts)
// On the Anvil fork these are Anvil's public dev accounts, written by anvil-provision into .anvil/service.env.
// Values are never logged; only addresses are. Whether the boot demo runs (RECOURSE_ANVIL_RUN=1) is index.ts's
// decision; the accounts resolve whenever the keys are present so the judge controls can use them.
// ---------------------------------------------------------------------------

const KEY = /^0x[0-9a-fA-F]{64}$/;

export interface RecourseAccounts {
  rootNode: PrivateKeyAccount;
  /** The seller accounts in their default behaviours (the boot demo's cast). */
  sellers: { honest: PrivateKeyAccount; ghost: PrivateKeyAccount; swap: PrivateKeyAccount };
  /** The same three accounts in RECOURSE_SELLER_KEYS order. */
  sellerList: readonly [PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount];
}

export type RecourseAccountsResult = { ok: true; accounts: RecourseAccounts } | { ok: false; reason: string };

export function resolveRecourseAccounts(env: NodeJS.ProcessEnv = process.env): RecourseAccountsResult {
  const root = env["AGENT_ROOT_KEY"]?.trim();
  if (!root || !KEY.test(root)) return { ok: false, reason: "AGENT_ROOT_KEY must be a 0x 64-hex key (the treasury root node key)" };
  const raw = (env["RECOURSE_SELLER_KEYS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.length !== 3) return { ok: false, reason: `RECOURSE_SELLER_KEYS must hold exactly 3 comma-separated keys (honest, ghost, swap), got ${raw.length}` };
  if (!raw.every((k) => KEY.test(k))) return { ok: false, reason: "RECOURSE_SELLER_KEYS entries must be 0x 64-hex keys" };
  const all = [root, ...raw].map((k) => k.toLowerCase());
  if (new Set(all).size !== all.length) return { ok: false, reason: "the root node key and the three seller keys must be distinct accounts" };
  const [honest, ghost, swap] = (raw as [Hex, Hex, Hex]).map((k) => privateKeyToAccount(k)) as [PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount];
  return {
    ok: true,
    accounts: { rootNode: privateKeyToAccount(root as Hex), sellers: { honest, ghost, swap }, sellerList: [honest, ghost, swap] },
  };
}
