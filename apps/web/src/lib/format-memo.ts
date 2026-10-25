import { formatAtomic } from "@/components/shared/money";

/** Display form of a service memo: "<n> atomic USDC" becomes "20.00 USDC" and every 0x value becomes 0x1234…abcd. */
export function formatMemo(memo: string): string {
  return memo
    .replace(/(\d+) atomic USDC/g, (_, n: string) => `${formatAtomic(BigInt(n))} USDC`)
    .replace(/0x[0-9a-fA-F]{9,}/g, (hex) => `${hex.slice(0, 6)}…${hex.slice(-4)}`);
}
