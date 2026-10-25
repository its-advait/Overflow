/**
 * Node-only: where an agent node key lives and how it signs. Imported as `@overflow/payment-client/signers`
 * (the package root stays browser-safe). `@coinbase/cdp-sdk` is loaded only when a CDP signer is requested.
 */
export { CdpAccountNameSchema, CdpSignerError, cdpSigner, wrapCdpAccount, type CdpSignerOptions } from "./cdp";
export { envKeySigner } from "./env-key";
export {
  CDP_CREDENTIAL_ENV,
  KeyOrAddressSchema,
  NodeSignerModeSchema,
  missingCdpCredentials,
  presentEnv,
  resolveNodeSigner,
  type NodeSignerMode,
  type ResolveNodeSignerOptions,
} from "./resolve";
export { SignatureFormatError, inspectSignature, normalizeEcdsaSignature, type SignatureInspection } from "./signature";
export type { CdpAccountLike, CdpClientLike, NodeSignerKind, ResolvedNodeSigner } from "./types";
