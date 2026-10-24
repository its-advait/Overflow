# Overflow: rules for Claude Code

## What we're building
Overflow lets a team of AI agents share one USDC budget on Base Sepolia, buy digital resources over x402, and pay sellers through per-order escrow that releases only on verifiable delivery. Spec: docs/SPEC.md. Progress log: docs/PROGRESS.md. Leash reference code: reference/leash (read-only).

## Non-negotiable design rules
- Agents propose; only contracts move money. No code path moves USDC except OverflowTreasury.settle()/reserve() and OverflowEscrow.
- A valid signature is never enough: every payment passes the treasury's policy checks, and USDC asks the treasury (ERC-1271) before moving funds.
- Keep three events separate everywhere: authorization, escrow funding, final settlement.
- A refund restores treasury USDC, not the agent's spent allowance.
- Money is integer atomic units (USDC has 6 decimals) as bigint or decimal strings. Never floats.
- Never retry an uncertain payment with a new nonce. Reconcile the original first.
- Hash fixed ABI-encoded fields, never JSON.
- Label anything simulated (sellers, datasets, attacker, company books) in code, UI and docs.
- No UI element may show success that did not come from a confirmed chain event or a real API response.

## Chain facts
Base Sepolia, chain 84532. USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e, EIP-712 name "USDC", version "2", 6 decimals, domain separator 0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818. USDC has no eip712Domain(): read name(), version(), DOMAIN_SEPARATOR(). Its reverts are Error(string), e.g. "FiatTokenV2: invalid signature".

## Stack
pnpm monorepo, TypeScript strict, Next.js + Tailwind + shadcn/ui, Node service, Foundry + OpenZeppelin 5, viem, Zod at every boundary, Postgres + Drizzle, Vitest, Anthropic SDK as the only model provider (model name from CLAUDE_MODEL).

## Commands
pnpm dev | pnpm test | pnpm typecheck | pnpm contracts:test | pnpm --filter <pkg> <script>

## Working style
Plan before coding. Make the smallest change that meets the prompt. Run the checks you were given and report real results. Update docs/PROGRESS.md before committing.
