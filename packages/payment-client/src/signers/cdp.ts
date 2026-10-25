import { getAddress, recoverTypedDataAddress, type Address, type Hex, type TypedDataDefinition, type TypedDataDomain } from "viem";
import { z } from "zod";
import type { NodeSigner } from "../authorization";
import type { TypedDataSigner } from "../typed-data";
import { normalizeEcdsaSignature } from "./signature";
import type { CdpAccountLike, CdpClientLike, ResolvedNodeSigner } from "./types";

/**
 * A Coinbase Developer Platform EVM server account (EOA) as an Overflow node key. The private key lives in
 * CDP's TEE; this process only ever sees the address and signatures. Every signature is normalized to the
 * chain's `v in {27, 28}` form and checked to recover to the account before it leaves this module.
 *
 * Credentials come from the environment the SDK reads itself (CDP_API_KEY_ID, CDP_API_KEY_SECRET,
 * CDP_WALLET_SECRET); nothing here reads, stores or logs them.
 */

/** CDP account names: 2 to 36 characters, alphanumerics and hyphens, no leading or trailing hyphen. */
export const CdpAccountNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,34}[A-Za-z0-9]$/, "CDP account name must be 2-36 alphanumerics or hyphens, not starting or ending with a hyphen");

export class CdpSignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpSignerError";
  }
}

export interface CdpSignerOptions {
  /** The CDP account name (looked up by name, so a rename or typo fails loudly instead of creating a key). */
  accountName: string;
  /** Pin: the account must have this address. */
  expectedAddress?: Address | undefined;
  /** Create the account when it does not exist. Only the check script does this; node paths look up only. */
  create?: boolean | undefined;
  /** Injected client (tests). Default: `new CdpClient()` from `@coinbase/cdp-sdk`, loaded lazily. */
  client?: CdpClientLike | undefined;
  /** Diagnostics hook: the raw signature as returned by CDP and its normalized form. Never called with secrets. */
  inspect?: ((raw: string, normalized: Hex) => void) | undefined;
}

/** Structural EIP-712 payload: what `TypedDataSigner` and `NodeSigner` both hand over. */
type AnyTypedData = {
  domain?: TypedDataDomain | undefined;
  types: Record<string, ReadonlyArray<{ readonly name: string; readonly type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

const shortMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);

async function loadCdpClient(): Promise<CdpClientLike> {
  const mod = await import("@coinbase/cdp-sdk");
  // The SDK ships its own viem copy; only structural types cross this boundary.
  return new mod.CdpClient() as unknown as CdpClientLike;
}

/** Wrap a CDP account so it satisfies both `NodeSigner` and `TypedDataSigner`. */
export function wrapCdpAccount(account: CdpAccountLike, source: string, inspect?: CdpSignerOptions["inspect"]): ResolvedNodeSigner {
  const address = getAddress(account.address);
  const signTypedData = async (parameters: AnyTypedData): Promise<Hex> => {
    const viemTypedData = parameters as unknown as TypedDataDefinition;
    let raw: string;
    try {
      raw = await account.signTypedData(viemTypedData);
    } catch (e) {
      throw new CdpSignerError(`${source}: signTypedData failed: ${shortMessage(e)}`);
    }
    let signature: Hex;
    try {
      signature = normalizeEcdsaSignature(raw);
    } catch (e) {
      throw new CdpSignerError(`${source}: ${shortMessage(e)}`);
    }
    inspect?.(raw, signature);
    const recovered = await recoverTypedDataAddress({ ...viemTypedData, signature });
    if (getAddress(recovered) !== address) {
      throw new CdpSignerError(`${source}: signature recovers to ${recovered}, not the account ${address}; discarding it`);
    }
    return signature;
  };
  const signer: NodeSigner & TypedDataSigner = { address, signTypedData };
  return { signer, address, kind: "cdp", source };
}

export async function cdpSigner(opts: CdpSignerOptions): Promise<ResolvedNodeSigner> {
  const name = CdpAccountNameSchema.parse(opts.accountName);
  const source = `cdp:${name}`;
  const client = opts.client ?? (await loadCdpClient());
  let account: CdpAccountLike;
  try {
    account = opts.create ? await client.evm.getOrCreateAccount({ name }) : await client.evm.getAccount({ name });
  } catch (e) {
    throw new CdpSignerError(`${source}: ${opts.create ? "getOrCreateAccount" : "getAccount"} failed: ${shortMessage(e)}`);
  }
  const resolved = wrapCdpAccount(account, source, opts.inspect);
  if (opts.expectedAddress !== undefined) {
    const expected = getAddress(opts.expectedAddress);
    if (expected !== resolved.address) {
      throw new CdpSignerError(`${source} is ${resolved.address}, but CDP_ACCOUNT_ADDRESS pins ${expected}`);
    }
  }
  return resolved;
}
