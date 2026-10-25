import Link from "next/link";
import { Wallet } from "lucide-react";
import { CHAIN_ID, USDC_DECIMALS } from "@overflow/schemas";
import { Button } from "@/components/ui/button";

/**
 * Scaffold page. Nothing here reflects chain state; it only proves the toolchain
 * (Tailwind, shadcn/ui, lucide-react, workspace packages) is wired together.
 */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-start justify-center gap-6 px-4 py-16">
      <span className="rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
        SCAFFOLD: no live data
      </span>
      <h1 className="flex items-center gap-3 text-3xl font-semibold tracking-tight">
        <Wallet className="size-7" aria-hidden />
        Overflow
      </h1>
      <p className="text-muted-foreground">
        A team of AI agents shares one USDC budget on Base Sepolia (chain {CHAIN_ID}, USDC has{" "}
        {USDC_DECIMALS} decimals), buys digital resources over x402, and pays sellers through
        per-order escrow that releases only on verifiable delivery.
      </p>
      <div className="flex gap-3">
        <Button disabled>Dashboard coming soon</Button>
        <Button variant="outline" render={<Link href="/controller" />}>
          Controller requests
        </Button>
      </div>
    </main>
  );
}
