import { AddressSchema, type Address } from "@overflow/schemas";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { simulatedAddress } from "./prices.js";

// ---------------------------------------------------------------------------
// SIMULATED seller configuration. The attacker payee for /premium-intel comes
// only from ATTACKER_ADDRESS and must never equal a legitimate payee; it is
// never allowlisted anywhere in this repo.
// ---------------------------------------------------------------------------

const PrivateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte private key");

const EnvSchema = z.object({
  SELLER_URL: z.url().default("http://localhost:4100"),
  PAYEE_SEARCH_ADDRESS: AddressSchema.optional(),
  PAYEE_SCRAPE_ADDRESS: AddressSchema.optional(),
  /** Comma-separated SIMULATED seller keys; [0] and [1] back the payees when the explicit addresses are unset. */
  SELLER_KEYS: z.string().optional(),
  ATTACKER_ADDRESS: AddressSchema.optional(),
  CONTEXT_DEV_API_KEY: z.string().min(1).optional(),
  DEMO_MODE: z.string().optional(),
});

export type PayeeSource = "env" | "seller-keys" | "simulated-default";

export interface SellerConfig {
  /** Public base URL the 402 `resource.url` and the fixture listing use. */
  sellerUrl: string;
  port: number;
  payees: { search: Address; scrape: Address };
  payeeSource: PayeeSource;
  /** SIMULATED attacker payee; null disables /premium-intel (503). */
  attacker: Address | null;
  /** Real search provider key; null means labeled canned results. */
  contextDevKey: string | null;
  /** DEMO_MODE=true: honor the force-broadcast header so the attack demo lands its revert on chain. */
  allowForceBroadcast: boolean;
}

function compact(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "") out[k] = v;
  return out;
}

export class SellerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SellerConfigError";
  }
}

export function resolveSellerConfig(env: NodeJS.ProcessEnv = process.env): SellerConfig {
  const parsed = EnvSchema.safeParse(compact(env));
  if (!parsed.success) {
    throw new SellerConfigError(`invalid seller env: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  const e = parsed.data;
  const sellerUrl = e.SELLER_URL.replace(/\/$/, "");
  const url = new URL(sellerUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));

  let payees: SellerConfig["payees"];
  let payeeSource: PayeeSource;
  if (e.PAYEE_SEARCH_ADDRESS && e.PAYEE_SCRAPE_ADDRESS) {
    payees = { search: getAddress(e.PAYEE_SEARCH_ADDRESS), scrape: getAddress(e.PAYEE_SCRAPE_ADDRESS) };
    payeeSource = "env";
  } else {
    const keys = (e.SELLER_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
    if (keys.length > 0) {
      const parsedKeys = keys.map((k) => PrivateKey.parse(k) as Hex);
      const first = privateKeyToAccount(parsedKeys[0]!).address;
      const second = parsedKeys[1] ? privateKeyToAccount(parsedKeys[1]).address : first;
      payees = {
        search: e.PAYEE_SEARCH_ADDRESS ? getAddress(e.PAYEE_SEARCH_ADDRESS) : first,
        scrape: e.PAYEE_SCRAPE_ADDRESS ? getAddress(e.PAYEE_SCRAPE_ADDRESS) : second,
      };
      payeeSource = "seller-keys";
    } else {
      payees = {
        search: e.PAYEE_SEARCH_ADDRESS ? getAddress(e.PAYEE_SEARCH_ADDRESS) : simulatedAddress("overflow.simulated.payee.search"),
        scrape: e.PAYEE_SCRAPE_ADDRESS ? getAddress(e.PAYEE_SCRAPE_ADDRESS) : simulatedAddress("overflow.simulated.payee.scrape"),
      };
      payeeSource = "simulated-default";
    }
  }

  const attacker = e.ATTACKER_ADDRESS ? getAddress(e.ATTACKER_ADDRESS) : null;
  if (attacker && (attacker === payees.search || attacker === payees.scrape)) {
    throw new SellerConfigError(`ATTACKER_ADDRESS ${attacker} equals a legitimate payee; the attacker must never be a payee the owner allowlists`);
  }

  return {
    sellerUrl,
    port,
    payees,
    payeeSource,
    attacker,
    contextDevKey: e.CONTEXT_DEV_API_KEY ?? null,
    allowForceBroadcast: e.DEMO_MODE === "true",
  };
}
