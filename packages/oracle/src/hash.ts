import { encodeAbiParameters, keccak256, parseAbiParameters, stringToBytes, type Hex } from "viem";

// ---------------------------------------------------------------------------
// Audit hashes for model calls (docs/SPEC.md "Oracle" guardrails: each model
// call's prompt and output hash are stored). Fixed ABI-encoded fields, never
// JSON, so the same call always gives the same hash.
// ---------------------------------------------------------------------------

export interface PromptHashInput {
  model: string;
  system: string;
  /** The user turns, concatenated in order (retries append the error turn). */
  user: string;
  /** JSON Schema text the model was constrained to. */
  schema: string;
}

export const PROMPT_HASH_ABI = parseAbiParameters("string model, string system, string user, string schema");

export function promptHash(input: PromptHashInput): Hex {
  return keccak256(encodeAbiParameters(PROMPT_HASH_ABI, [input.model, input.system, input.user, input.schema]));
}

/** keccak256 over the raw UTF-8 bytes of the model's text output. */
export function outputHash(rawText: string): Hex {
  return keccak256(stringToBytes(rawText));
}
