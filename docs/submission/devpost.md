# Overflow (Devpost submission draft)

> Status as of 2026-10-25. Every number below cites a file, a test or a transaction. Anything not yet run says TODO. Simulated parts are labeled SIMULATED.

**Prior work disclosure.** Leash, our B@BHacks project, is prior work; this repo's code was written during Cal Hacks 13.0. Overflow ports Leash's `settle()` check order, its stateful ERC-1271 gate, gasless signed delegation, ancestor pause, balance floor and `remaining()` view into new contracts (`OverflowTreasury`), and adds everything else listed under "How we built it" (see docs/SPEC.md, "Security core carried over from Leash", and docs/PROGRESS.md for the build log).

## Inspiration

x402 lets *an* agent pay. A business still can't safely let a *team* of agents spend its money. Coinbase's agent tools offer two extremes: approve every action, or one limit per wallet. Budgets don't split across sub-agents, and x402 payments are final, so a seller who sends junk keeps the money. We wanted a finance team's answer: one budget, limits that roll up through sub-agents, and accounts payable where "goods received" is a cryptographic check.

## What it does

Overflow gives a team of AI agents one USDC budget on Base Sepolia, lets them find and co-fund digital resources over x402, and pays sellers through a per-order escrow that releases only on verifiable delivery.

- **Leash core (OverflowTreasury).** Every payment is checked onchain against the agent tree (payee allowlist, per-call limit, budget walked up through every ancestor, expiry, pause). A valid signature is not enough: a prompt-injected agent can sign a payment to an attacker and the treasury still rejects it. Sending that same signature straight to USDC also fails, because USDC asks the treasury (ERC-1271) and the treasury only says yes inside its own checks.
- **Recourse (OverflowEscrow).** Each order gets its own escrow contract address, so the agent's signed `to` field binds the order. The seller commits Merkle roots and a key hash up front; the buyer samples chunks before paying; after payment the seller reveals the key. The escrow pays the seller on `accept()`, or refunds the treasury on a timeout (seller never reveals) or a chunk mismatch proof (seller swapped data), with the seller's bond.
- **Oracle.** Claude (Anthropic SDK) plus deterministic checks decides what is worth buying and judges the sample.
- **Fusion.** Merges compatible requests from several agents into one purchase charged once, to their lowest common ancestor.
- **Finance layer.** The indexer books journal entries from chain events, reconciliation compares the books to the chain and opens exceptions for a controller.

Three events stay separate in contracts, ledger and UI: authorization, escrow funding, final settlement. A refund restores treasury USDC, not the agent's spent allowance.

**Real versus SIMULATED.** Real: contracts deployed on Base Sepolia (`packages/schemas/deployments/base-sepolia.json`), testnet USDC, the x402 quote-sign-settle flow, Claude as the model. SIMULATED and labeled: the seller catalog and datasets (synthetic), the cheating sellers (`swap`, `ghost` behaviors), the attacker address, and the fictional company Larkspur Research Partners and its books.

## How we built it

- **Contracts (Solidity, Foundry, OpenZeppelin 5):** `OverflowTreasury` (`settle()`, `reserve()` / `release()` for third-party facilitators, ERC-1271 gate), `OverflowEscrowFactory` and `OverflowEscrow` (tier 1 payout and timeout refund, tier 2 chunk mismatch proofs, tier 3 signed-record promises, bonds and cheater flags, `sweep()`).
- **Offchain (TypeScript, pnpm monorepo):** `@overflow/payment-client` (x402 quote checks, EIP-3009 signing, typed-data golden vectors pinned against the contract), `@overflow/recourse-crypto` (chunking, per-buyer keys, domain-separated Merkle proofs), `@overflow/oracle`, `@overflow/fusion`, `@overflow/database` (Drizzle on Postgres or PGlite), and `apps/service` (Hono API, relayer and in-process facilitator, chain indexer and SSE stream, ledger posting and reconciliation, purchase state machine with idempotency keys, mission runner, delivery watcher, SIMULATED Recourse sellers).
- **Web (Next.js, Tailwind, shadcn):** Overview (money cards, mission progress, latest events with the Blocked lane and decoded revert reasons), Missions, Purchases (Oracle comparison, Fusion proposal, authorization preview, payment timeline with escrow state), Ledger with reconciliation, and Settings, the live control panel for a judge's own scenario (docs/SPEC.md "A judge's own scenario"): seller behavior (honest, swap, ghost), price, agent caps, a new payee and a license flag, each working live with no code change. Agent caps and a new payee are treasury policy changes the controller signs onchain; seller behavior, price and the license flag change what the SIMULATED seller does, quotes and licenses on the next order (Live tx / result: TODO). The Agents, Escrow and Activity pages are still placeholders in this commit.
- **Live test and demo:** the purchase beats run on Base Sepolia with real transactions (`pnpm --filter @overflow/service flow:demo -- --beat honest|ghost|swap`, which also requires reconciliation to show no open exception), and the refusal and controller beats run against the deployed treasury and real USDC. Every result is cited by its Basescan link once the live run happens.
- **Labeled fallback:** a scripted replay mode (`DEMO_SCRIPTED=record|replay`) replaces only the model's answers; everything after the model still runs on chain. Replay shows a SCRIPTED badge and prefixes every log line with `[SCRIPTED]` (`data/scripted/README.md`).

## Challenges we ran into

- **Coinbase's facilitator and a contract payer.** Our spike (`docs/coinbase-feedback.md`) sent treasury-as-payer x402 payloads to Coinbase's CDP facilitator and to the public x402.org one. The public facilitator rejects every treasury payload with `invalid_exact_evm_signature`. The CDP facilitator passes the signature stage and then fails its onchain simulation with `invalid_payload: contract call failed: unable to call contract: execution reverted`. Settling through Coinbase's facilitator with a live `reserve()` is UNPROVEN, so the Coinbase adapter stays BLOCKED and labeled, and the demo uses the Overflow facilitator path (`settle()`).
- **Testnet funding.** Faucets need a human. At the last check the treasury held 0 USDC and the relayer 0 ETH (docs/PROGRESS.md, "live P6.3 / P6.4 / P6.5 checks"), so live Base Sepolia mission runs were not run.
- **The indexer against the real ABI.** We found that a hand-written provisional ABI had selectors that did not match the deployed escrow and factory; we switched the indexer to the generated ABIs (docs/PROGRESS.md, "end-to-end purchase flow").
- **Public RPC limits.** `eth_getLogs` is capped at a 200-block range on the public RPC; the sweep reconciler still needs block chunking (open issue in docs/PROGRESS.md).

## Accomplishments that we're proud of

- **Contracts deployed on Base Sepolia** (chain 84532), from `packages/schemas/deployments/base-sepolia.json`:
  - Treasury `0x03805bdE8BD8266Ad525A9eb13A0eDa7fAcaDca2`, deploy tx https://sepolia.basescan.org/tx/0xbb9fd87f128ef5783b4765d4741001287acc4d495ee996fb9e8979db6c5b301c
  - Escrow factory `0x933Bc257a24D94786D0021745470D343d3391808` (and escrow implementation `0x16fb922f0b3aa2c09d0e5e56640f7b0fd3e14f20`), deploy tx https://sepolia.basescan.org/tx/0x17570db986b411cd99fd0f336627d23f8bb2298750537234d37d1955bb11d20f
  - `setEscrowFactory` tx https://sepolia.basescan.org/tx/0x292d0e3cdce7cde3715afee886fcbdeab95fac62668f2a6c7733daba92b5e948
  - `createRoot` tx https://sepolia.basescan.org/tx/0x4aea260876dc3cfa33bdedbebd4791a7550d39f3349229656693a870abf9f7b2
- **Live test on Base Sepolia (not run yet).** The team proves Overflow with a live test and a live demo against the deployed contracts and testnet USDC. No live run has happened, so every slot below is TODO; no hash or number goes here until the transaction exists.
  - Honest SIMULATED seller paid: escrow funded, key revealed, order accepted, `PaidOut`. Live tx: TODO (Basescan link after the live run)
  - Ghost SIMULATED seller never reveals: timeout refund to the treasury. Live tx: TODO (Basescan link after the live run)
  - Swap SIMULATED seller: chunk mismatch proof, refund plus the seller's bond, seller flagged. Live tx: TODO (Basescan link after the live run)
  - The flagged seller opens a new order: `PayeeFlagged`. Live tx: TODO (Basescan link after the live run)
  - A prompt-injected agent signs a payment to the SIMULATED attacker: `PayeeNotAllowed`. Live tx: TODO (Basescan link after the live run)
  - The same signature sent straight to USDC: `FiatTokenV2: invalid signature`. Live tx: TODO (Basescan link after the live run)
  - A sub-agent over its parent's cap: `OverBudget`. Live tx: TODO (Basescan link after the live run)
  - A paused orchestrator: `Paused`. Live tx: TODO (Basescan link after the live run)
  - Controller actions: agent caps and a new payee from Settings, plus pause, each signed onchain by the controller. Live tx: TODO (Basescan link after the live run)
- **Contract tests:** `pnpm contracts:test` 20 suites, 196 passed, 0 failed, 1 skipped (fork suite off-fork), per docs/PROGRESS.md "end-to-end purchase flow". Includes `contracts/test/unit/Reservations.t.sol` (16 tests: a reserved payment settles through a direct USDC call; without `reserve` the same call fails `FiatTokenV2: invalid signature`).
- **Offchain tests:** `pnpm test` exit 0, 87 files, 736 tests (docs/PROGRESS.md, 2026-10-25 "Verified (real output)" table). Covers quote-versus-order checks, Recourse crypto golden vectors, the indexer against the real-ABI fixture, ledger posting, and reconciliation (an injected +0.50 USDC difference opens one exception in `ledger/reconciliation.test.ts`).
- **Honest labels everywhere:** simulated sellers, datasets, the attacker and the company are labeled SIMULATED in code, UI and docs, and the SCRIPTED badge appears only when the service itself reports replay mode.

## What we learned

- ERC-1271 lets a policy contract be the payer of record for EIP-3009 USDC, so USDC itself enforces the policy: a signature that skips the treasury's checks is just invalid.
- Giving every order its own escrow address is the simplest way to bind an x402 payment to an order: the `to` field the agent signs is the order.
- Facilitators differ on contract payers: the public x402.org facilitator recovers an EOA and stops; the CDP facilitator simulates the transfer onchain (`docs/coinbase-feedback.md`).
- An uncertain payment must be reconciled, never retried with a new nonce; that rule shaped the purchase state machine (`PAYMENT_UNKNOWN`, `reconcilePayment`).

## What's next

- Fund the testnet treasury, relayer and SIMULATED seller keys, then run the live test and live demo on Base Sepolia (honest, ghost and swap missions, the flagged seller, the attacker payee, the over-cap sub-agent, the paused orchestrator, the direct-to-USDC bypass and the Settings controller actions) and record the scripted replay (procedure in docs/PROGRESS.md "To unblock" and `data/scripted/README.md`).
- Prove settlement through Coinbase's facilitator with a live `reserve()` (rerun `pnpm spike:coinbase`).
- Path to production (from docs/SPEC.md, Risks and Known limitations): an audit, agent keys in CDP server wallets instead of server secrets, mainnet USDC, private policies (policies and budgets are public onchain today), persisted Recourse order store, RPC log chunking.

## Built with

Solidity, Foundry (forge, anvil), OpenZeppelin Contracts 5, forge-std, TypeScript, Node.js, pnpm, viem, Zod, Hono, Next.js, React, Tailwind CSS, shadcn/ui, Base UI, lucide-react, Drizzle ORM, PostgreSQL (postgres.js), PGlite, Anthropic SDK (Claude), x402 (`@x402/core`, `@x402/evm`, `@x402/hono`), `@coinbase/x402`, Vitest, tsx, tsup, Base Sepolia, USDC.

## Prize tracks

- **Coinbase: Best Use of x402, Payment Agents.** x402 answered how an agent pays; Overflow answers how a business lets a team of agents spend, with an onchain policy tree, an ERC-1271 gate on USDC and a per-order escrow as the x402 `payTo` (Coinbase facilitator path built with `reserve()` but BLOCKED live; see `docs/coinbase-feedback.md`).
- **Hyphenate: Autonomous Systems for Finance.** Procurement analyst and accounts-payable clerk for a company's AI-agent data spend.
- **Microsoft: Built for the Real World.** A finance agent for teams running agent fleets: idempotent payments that are reconciled, never retried with a new nonce, books that follow chain events, and a stated path to production.
- **Armadin: Best Security Hack.** A tricked agent can't move money: the treasury rejects the injected payee, USDC rejects the same signature sent around the treasury and the escrow refunds by proof when a seller cheats (Foundry-tested; each beat runs live on Base Sepolia in the demo, Live tx: TODO).

## Links

- Repo: https://github.com/its-advait/Overflow
- Architecture: [docs/architecture.md](../architecture.md)
- Metrics: [docs/metrics.md](../metrics.md)
- Coinbase builder feedback: [docs/coinbase-feedback.md](../coinbase-feedback.md)
- Submission docs: [docs/submission/](./) (this file and the other `*.md` files in this folder)
- Demo runbook: [docs/DEMO.md](../DEMO.md)
- Demo video: TODO

## TODO before submitting

- Video link.
- Live Base Sepolia transactions for every live beat: honest payout, ghost timeout refund, swap mismatch refund, `PayeeFlagged`, `PayeeNotAllowed`, the direct-to-USDC `FiatTokenV2: invalid signature`, `OverBudget`, `Paused` and the Settings controller actions (none exist yet; do not add numbers until they do).
- docs/architecture.md and docs/metrics.md were being written in parallel with this draft (untracked at the time); check they are committed.
- Check Armadin's criteria and prize on the live site (SPEC says the sponsor sheet listed them as "coming soon").
