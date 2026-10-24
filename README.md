# Overflow

A team of AI agents shares one USDC budget on Base Sepolia, buys digital resources over x402, and pays sellers through per-order escrow that releases only on verifiable delivery. Built at Cal Hacks 13.0.

- Spec: `docs/SPEC.md`
- Progress log: `docs/PROGRESS.md`
- Rules for Claude Code: `CLAUDE.md`

## Setup

```sh
git clone --recurse-submodules <repo>   # contracts/lib are git submodules
pnpm install
cp .env.example .env                     # fill in values
pnpm typecheck && pnpm build && pnpm test
pnpm contracts:build && pnpm contracts:test
```

Optional read-only reference (git-ignored, never imported):

```sh
git clone --depth 1 https://github.com/AnthonyOlakangil/leash reference/leash
```

## Layout

- `apps/web` Next.js App Router UI (Tailwind, shadcn/ui, lucide-react)
- `apps/service` Node service: `api/`, `orchestration/`, `facilitator/`, `sellers/`, `chain/`
- `packages/*` shared libraries: `schemas`, `oracle`, `fusion`, `payment-client`, `recourse-crypto`, `database`
- `contracts` Foundry project (solc 0.8.28, cancun, OpenZeppelin 5)
- `docs` spec, progress, changelog
