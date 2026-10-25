import { LedgerAccountSchema, type FinancialEntry, type LedgerAccount } from "@overflow/schemas";
import type { Tone } from "@/components/shared/status-pill";
import type { Balance } from "@/lib/api/contracts";

// ---------------------------------------------------------------------------
// Chart of accounts as the controller reads it (SPEC "Journal entries"). Every
// amount is bigint; the server's `netAtomic` is debits - credits, so a
// credit-normal account (equity, income) reads negative there and is flipped
// here for display. Exhaustive records: adding an account fails typecheck.
// ---------------------------------------------------------------------------

export type AccountKind = "asset" | "expense" | "equity" | "income";

export const ACCOUNT_STYLE: Record<LedgerAccount, { label: string; kind: AccountKind; normal: "debit" | "credit"; hint: string }> = {
  "usdc-treasury": { label: "USDC treasury", kind: "asset", normal: "debit", hint: "USDC the treasury contract holds. Reconciled against balanceOf(treasury)." },
  "escrow-deposit": { label: "Escrow deposit", kind: "asset", normal: "debit", hint: "USDC sitting in open per-order escrows, still the company's until delivery is accepted." },
  "data-expense": { label: "Data expense", kind: "expense", normal: "debit", hint: "Accepted deliveries and direct x402 purchases, split by department." },
  "owner-contribution": { label: "Owner contribution", kind: "equity", normal: "credit", hint: "The controller's funding of the treasury." },
  "other-income-seller-forfeiture": { label: "Other income: seller forfeiture", kind: "income", normal: "credit", hint: "Bonds forfeited by sellers proven to cheat or who missed a reveal." },
};

export const ACCOUNTS: readonly LedgerAccount[] = LedgerAccountSchema.options;

/** The balance on the account's normal side: positive when the books are as expected. */
export function normalBalance(b: Balance): bigint {
  const net = BigInt(b.netAtomic);
  return ACCOUNT_STYLE[b.account].normal === "debit" ? net : -net;
}

/** Σ debits and Σ credits over every account; a double-entry book always balances. */
export function trialBalance(balances: readonly Balance[]): { debitsAtomic: bigint; creditsAtomic: bigint; balanced: boolean } {
  let debitsAtomic = 0n;
  let creditsAtomic = 0n;
  for (const b of balances) {
    debitsAtomic += BigInt(b.debitsAtomic);
    creditsAtomic += BigInt(b.creditsAtomic);
  }
  return { debitsAtomic, creditsAtomic, balanced: debitsAtomic === creditsAtomic };
}

export type EntryPhase = "funding" | "escrow-funding" | "settlement" | "refund" | "forfeiture" | "direct-purchase" | "other";

/**
 * What a (debit, credit) pair means, from the SPEC's journal table. The three
 * financial events keep distinct labels and tones: escrow funding (cyan) is
 * never shown as settlement (success) or refund (warning).
 */
export function entryKind(entry: Pick<FinancialEntry, "debitAccount" | "creditAccount">): { label: string; phase: EntryPhase; tone: Tone } {
  const pair = `${entry.debitAccount}/${entry.creditAccount}`;
  switch (pair) {
    case "usdc-treasury/owner-contribution":
      return { label: "Treasury funded", phase: "funding", tone: "blue" };
    case "escrow-deposit/usdc-treasury":
      return { label: "Escrow funded", phase: "escrow-funding", tone: "cyan" };
    case "data-expense/escrow-deposit":
      return { label: "Delivery accepted", phase: "settlement", tone: "success" };
    case "usdc-treasury/escrow-deposit":
      return { label: "Refund", phase: "refund", tone: "warning" };
    case "usdc-treasury/other-income-seller-forfeiture":
      return { label: "Bond forfeited", phase: "forfeiture", tone: "violet" };
    case "data-expense/usdc-treasury":
      return { label: "Direct x402 purchase", phase: "direct-purchase", tone: "success" };
    default:
      return { label: "Other", phase: "other", tone: "muted" };
  }
}
