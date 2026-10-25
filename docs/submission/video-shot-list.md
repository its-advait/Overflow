# Demo video shot list (Hyphenate cut, 3:00)

Follows docs/SPEC.md "Demo script": open with the moment, keep one mission running throughout, label every simulated part on screen. Status as of 2026-10-25.

**Most of this video cannot be shot yet.** The live Base Sepolia missions (honest, ghost, swap) have not run: the treasury holds 0 USDC and the relayer 0 ETH (docs/PROGRESS.md, 2026-10-25 "Not done: no transaction was sent"). No escrow-funding or refund transaction exists, and no scripted-replay recording exists. Four of the screens are still placeholders in apps/web: Escrow, Agents, Activity (Blocked lane) and Settings.

Status key:
- **READY:** can be recorded now from real data.
- **NEEDS LIVE RUN:** depends on a Base Sepolia run that has not happened. Do not record a stand-in.
- **NOT BUILT:** the screen is a placeholder (`PlaceholderPage`) in apps/web/src/app.

## Standing on-screen labels (every shot)

- Company: "Larkspur Research Partners (SIMULATED)" (packages/database/src/seed.ts).
- Sellers and datasets: "SIMULATED seller A (Registry Data Co.)", "SIMULATED seller B (Mobility Insights)", listing titles begin "SIMULATED:" (data/catalog.json).
- Attacker: "SIMULATED attacker (no key, never allowlisted)".
- Any fork footage: "anvil fork of Base Sepolia, local only, not on Basescan".
- If replay is ever used, the SCRIPTED badge must be visible in the top bar (docs/SPEC.md "Scripted replay"). No recording exists today.

## Shots

| Time | Screen | What happens on screen | Voiceover (draft) | Proves | Status |
|---|---|---|---|---|---|
| 0:00–0:20 | Escrow detail (`/escrow`) | SIMULATED seller swapped one record after the sample. Agent submits the chunk (mismatch) proof; refund plus bond land on Basescan; seller flagged. Cut to the Basescan refund tx page. | "This seller swapped one record after we sampled it. The agent proved it onchain, and the escrow refunded us plus the seller's bond." | Hyphenate moment, Armadin | **NEEDS LIVE RUN** (`flow:demo -- --beat swap`; refund tx link is TODO in docs/submission/hyphenate.md) and **NOT BUILT** (`/escrow` is a placeholder). Basescan footage is possible once the tx exists. |
| 0:20–0:40 | Overview (`/`) | Title card: "x402 lets an agent pay. A business can't safely let a team of agents spend." Mission starts: research the EV market, 50 USDC. | Problem statement as on screen. | The problem | Screen exists (READY). Mission start **NEEDS LIVE RUN**: the treasury holds 0 USDC, and the treasury balance on screen must come from the chain. |
| 0:40–1:05 | Agents (`/agents`) | Controller funds the treasury from Coinbase Wallet; the orchestrator delegates to three sub-agents by signature, paying no gas. | "The controller funds one treasury. The orchestrator splits its budget across three sub-agents with a signature; the relayer pays the gas." | Coinbase, the Leash core | **NOT BUILT** (`/agents` is a placeholder). Funding **NEEDS LIVE RUN** (deployer holds 0 USDC). Coinbase Wallet controller approval not evidenced in docs/PROGRESS.md: TODO. No live `createChild` tx is recorded in docs/PROGRESS.md; gasless `createChild` has run on the anvil fork (docs/proof/results.md). |
| 1:05–1:30 | Purchases (`/purchases`) | Oracle rejects a dataset with the wrong dates; Fusion merges two agents' requests into one 12 USDC purchase (the 12 USDC listing is `listing-national-monthly-2024-2026`, data/catalog.json, SIMULATED). | "Oracle drops the dataset that doesn't cover the dates we need. Fusion sees two agents asking for the same data and buys it once." | Hyphenate, Microsoft | Screen exists. Content **NEEDS LIVE RUN** (mission not run). Proof cases 12 and 15 are NOT IMPLEMENTED (docs/proof/results.md). |
| 1:30–2:00 | Payment timeline (purchase detail, `/purchases/[id]`; confirm with the web owner) | An agent pays a third-party x402 API through Coinbase's facilitator (`reserve()`), then funds the dataset's escrow. | "One payment interface, two paths: a direct x402 API call through Coinbase's facilitator, and an escrowed dataset purchase." | Coinbase | **NEEDS LIVE RUN**: `pnpm demo:facilitator` not run (docs/PROGRESS.md); no escrow funding tx exists. |
| 2:00–2:25 | Blocked lane (`/activity`) | An injected listing makes an agent sign a payment to an attacker: `PayeeNotAllowed`. The same signature sent to USDC: `FiatTokenV2: invalid signature`. | "The agent was tricked and signed. The treasury refused. Sending the same signature straight to USDC fails too: USDC asks the treasury first." | Armadin, Coinbase engineers | **NOT BUILT** (`/activity` is a placeholder). Live `pnpm proof --live` cases 1–2 BLOCKED (relayer 0 ETH). **Labeled fallback that is real today:** terminal capture of `pnpm proof --fork` cases 1 and 2 (PASS, docs/proof/results.md) with the fork label on screen; it has no Basescan link. |
| 2:25–2:45 | Ledger (`/ledger`) | The honest seller is paid; entries booked by department (research, finance); reconciliation shows no differences. | "The honest seller is paid on delivery, the expense is booked by department, and the books match the chain." | Hyphenate, Microsoft | Screen exists. Content **NEEDS LIVE RUN** (`flow:demo -- --beat honest`). |
| 2:45–3:00 | Overview (`/`) | The flagged seller tries a new order and is blocked (`PayeeFlagged`). Closing line. | "Overflow lets a team of agents spend on its own under rules a human sets once. It checks every payment onchain, and it gets the money back when a seller cheats." (docs/SPEC.md "Closing line") | All four | Blocked-seller beat **NEEDS LIVE RUN** (after the swap beat); proof case 18 NOT IMPLEMENTED. Closing line card is READY. |

Total: 3:00.

## What can be recorded today

- Closing line card and title cards.
- `pnpm proof --fork` terminal output for cases 1–7 (7/20 PASS), labeled as an anvil fork.
- Basescan pages for real deployment and owner txs: treasury `0x03805bde8bd8266ad525a9eb13a0eda7facadca2`, `setEscrowFactory` https://sepolia.basescan.org/tx/0x292d0e3cdce7cde3715afee886fcbdeab95fac62668f2a6c7733daba92b5e948 (packages/schemas/deployments/base-sepolia.json). These are setup transactions, not payments.

## Before recording (from docs/PROGRESS.md "To unblock")

1. Fund the deployer with Base Sepolia ETH and USDC from faucets (needs a human, CAPTCHA).
2. `pnpm dev:fund 12`; fund SIMULATED seller bonds and gas; relayer gas via `dev-fund-gas`.
3. `preflight --budget 5` shows 0 FAIL.
4. Run the beats with `flow:demo -- --beat honest`, `--beat ghost` and `--beat swap`, and record the screen while they run. Copy the escrow and refund tx links into docs/submission/hyphenate.md "The moment".
5. Build the Escrow, Agents and Activity pages, or re-plan those shots around Basescan and terminal footage, labeled.
