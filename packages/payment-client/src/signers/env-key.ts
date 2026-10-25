import { resolveSigner, type SignerSource } from "../keystore";
import type { ResolvedNodeSigner } from "./types";

/** A viem local account from a 64-hex env key or a Foundry keystore (the existing `resolveSigner` rules). */
export function envKeySigner(src: SignerSource): ResolvedNodeSigner {
  const r = resolveSigner(src);
  return {
    signer: r.account,
    address: r.account.address,
    kind: r.source.endsWith("(env)") ? "env-key" : "keystore",
    source: r.source,
  };
}
