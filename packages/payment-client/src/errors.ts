/** A field of the seller's 402 quote disagrees with our PurchaseOrder. Signing never happens after this. */
export class QuoteMismatchError extends Error {
  constructor(
    public readonly field: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`quote mismatch on ${field}: expected ${expected}, got ${actual}`);
    this.name = "QuoteMismatchError";
  }
}

/** The 402 response could not be decoded as an x402 v2 PaymentRequired. */
export class PaymentRequiredParseError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PaymentRequiredParseError";
  }
}

export interface DomainMismatch {
  field: string;
  expected: string;
  actual: string;
}

/** The live token is not the USDC we pinned (name, version, decimals or DOMAIN_SEPARATOR). */
export class TokenDomainMismatchError extends Error {
  constructor(public readonly mismatches: readonly DomainMismatch[]) {
    super(
      `token domain mismatch: ${mismatches
        .map((m) => `${m.field} expected ${m.expected}, got ${m.actual}`)
        .join("; ")}`,
    );
    this.name = "TokenDomainMismatchError";
  }
}

/** The client refused to produce a signature (for example from != treasury). */
export class SigningRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningRefusedError";
  }
}

/**
 * The paid request was sent but no response came back. The authorization may or may not
 * have been settled. Reconcile `digest` against the chain; never sign a new nonce first.
 */
export class PaymentOutcomeUnknownError extends Error {
  constructor(
    public readonly digest: `0x${string}`,
    public override readonly cause: unknown,
  ) {
    super(
      `paid request failed after the authorization was sent (digest ${digest}); reconcile before any retry`,
    );
    this.name = "PaymentOutcomeUnknownError";
  }
}
