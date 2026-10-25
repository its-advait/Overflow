import { MoneyFormatError, formatUsdc, toAtomic } from "@overflow/schemas";

// MissionComposer budget: the owner types USDC, the API gets integer atomic
// units. toAtomic() does the conversion on the string (CLAUDE.md: never a
// float); this only trims what people type and turns its errors into a
// sentence for the form.

export type BudgetParse = { ok: true; atomic: string; preview: string } | { ok: false; error: string };

export function parseBudgetInput(text: string): BudgetParse {
  const cleaned = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (cleaned === "") return { ok: false, error: "Enter a budget in USDC." };
  try {
    const atomic = toAtomic(cleaned);
    if (BigInt(atomic) === 0n) return { ok: false, error: "The budget must be more than 0 USDC." };
    return { ok: true, atomic, preview: `${formatUsdc(atomic)} USDC = ${atomic} atomic units` };
  } catch (e) {
    if (e instanceof MoneyFormatError) return { ok: false, error: `Not a USDC amount: ${e.message}` };
    throw e;
  }
}
