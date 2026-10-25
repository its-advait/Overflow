import type { Address, TypedDataDefinition } from "viem";
import type { NodeSigner } from "../authorization";
import type { TypedDataSigner } from "../typed-data";

/** Where a node signer's key lives. The key itself never appears in this type. */
export type NodeSignerKind = "env-key" | "keystore" | "cdp";

/** A node key ready to sign TransferWithAuthorization (USDC domain) and CreateChild/PauseChild (Overflow domain). */
export interface ResolvedNodeSigner {
  signer: NodeSigner & TypedDataSigner;
  address: Address;
  kind: NodeSignerKind;
  /** Human-readable origin for logs, e.g. `NODE_PRIVATE_KEY (env)`, `keystore overflow-node`, `cdp:overflow-node-root`. Never a secret. */
  source: string;
}

/** The slice of a CDP EVM server account (EOA) this package touches. Smart accounts (ERC-6492 signatures) do not fit. */
export interface CdpAccountLike {
  address: string;
  signTypedData(typedData: TypedDataDefinition): Promise<string>;
}

/** The slice of `CdpClient` this package touches; tests inject a fake, production loads `@coinbase/cdp-sdk` lazily. */
export interface CdpClientLike {
  evm: {
    getAccount(options: { name: string }): Promise<CdpAccountLike>;
    getOrCreateAccount(options: { name: string }): Promise<CdpAccountLike>;
  };
}
