# Overflow

Overflow lets a team of AI agents share one USDC budget on Base Sepolia, buy digital resources over x402, and pay sellers through a per-order escrow that releases only on verifiable delivery. Claude agents (Anthropic SDK) propose and sign; only three contracts move USDC. `OverflowTreasury` checks every payment against the agent tree's policy (payee allowlist, per-call limit, budget, expiry, pause) before any USDC moves, and USDC itself asks the treasury (ERC-1271) whether a signature is valid, so a signature that skips the treasury is refused. `OverflowEscrow` holds each order's funds until the seller reveals the key and the buyer checks the file. A cheating seller is refunded by proof and flagged. Built at Cal Hacks 13.0. Repo: https://github.com/its-advait/Overflow. Spec: [docs/SPEC.md](docs/SPEC.md).

## The baseline problem

x402 lets *an* agent pay. A business still can't safely let a *team* of agents spend its money. Coinbase's tools offer two extremes: approve every action (Wallet MCP), or one limit per wallet (Agentic Wallet, CDP policies). Budgets don't split across sub-agents, and x402 payments are final, so a seller who sends junk keeps the money (docs/SPEC.md, "Summary").

Overflow keeps three financial events separate in the contracts, the ledger and the UI: **authorization** (an agent may commit up to an amount for one order), **escrow funding** (USDC leaves the treasury into that order's escrow), and **final settlement** (the seller is paid, or the treasury is refunded). See [docs/architecture.md](docs/architecture.md).

## Real vs simulated

| Part | Status | Evidence |
|---|---|---|
| `OverflowTreasury`, `OverflowEscrowFactory`, escrow implementation on Base Sepolia | **Real, deployed** | treasury `0x03805bdE8BD8266Ad525A9eb13A0eDa7fAcaDca2`, deploy tx [0xbb9fd87f…301c](https://sepolia.basescan.org/tx/0xbb9fd87f128ef5783b4765d4741001287acc4d495ee996fb9e8979db6c5b301c); factory + implementation tx [0x17570db9…1d20f](https://sepolia.basescan.org/tx/0x17570db986b411cd99fd0f336627d23f8bb2298750537234d37d1955bb11d20f); `setEscrowFactory` [0x292d0e3c…e948](https://sepolia.basescan.org/tx/0x292d0e3cdce7cde3715afee886fcbdeab95fac62668f2a6c7733daba92b5e948); `createRoot` [0x4aea2608…f7b2](https://sepolia.basescan.org/tx/0x4aea260876dc3cfa33bdedbebd4791a7550d39f3349229656693a870abf9f7b2) (`packages/schemas/deployments/base-sepolia.json`) |
| Testnet USDC | Real (Circle's Base Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`) | The deployed treasury holds **0 USDC** today (docs/PROGRESS.md, 2026-10-25 "live P6.3 / P6.4 / P6.5 checks") |
| Policy refusals and the USDC gate | Real contract code, covered by Foundry tests against real USDC v2.2 bytecode; **live run on Base Sepolia pending** | Test names per attack in [docs/threat-model.md](docs/threat-model.md). Live tx: TODO (Basescan link after the live run) |
| LIVE test and LIVE demo on Base Sepolia (beats below) | **Not run yet** | Treasury 0 USDC, relayer 0 ETH (docs/PROGRESS.md, 2026-10-25 entries). Live tx: TODO (Basescan link after the live run) |
| Claude agents (Oracle extraction, sample judgment, mission plan, sub-agents) | Real Anthropic SDK calls, model from `CLAUDE_MODEL` | Exercised in Vitest with fakes; no live mission has run (above) |
| Scripted replay | Labeled fallback (`[SCRIPTED]` on every log line, badge in the top bar) | **No recording exists yet**: `data/scripted/` holds only its README |
| `overflow_pay` MCP server for any agent (`packages/overflow-mcp`: `overflow_budget`, `overflow_quote`, `overflow_pay`) | Real code, unit and MCP round-trip tests; **live Base Sepolia payment pending** (needs the funded treasury) | docs/PROGRESS.md, "`packages/overflow-mcp`"; [packages/overflow-mcp/README.md](packages/overflow-mcp/README.md). Live tx: TODO (Basescan link after the live run) |
| Controller approvals through Coinbase Wallet MCP | Real code (controller requests, submission record, `/controller` page, `overflow-controller` skill); tested against a SIMULATED fixture; **no live Wallet MCP call yet** | [docs/controller.md](docs/controller.md); docs/coinbase-feedback.md, "Wallet MCP controller". The owner txs recorded so far were signed by the deployer key with DEV ONLY scripts that SIMULATE the controller |
| CDP-held agent keys (`NODE_SIGNER=cdp`, optional) | Real code; **live sign check passed**, nothing broadcast | CDP server account `0x646F2bb89286aD517E0cc5420589a65dDe30A415` signed USDC and delegation payloads that recover to it (docs/coinbase-feedback.md, "CDP server accounts as agent keys") |
| Recourse orders end to end (honest, ghost, swap) | Real contracts, facilitator path and indexer on a **local Anvil fork** of Base Sepolia, SIMULATED sellers; nothing broadcast to Base Sepolia | docs/PROGRESS.md, "recourse orders end to end on local Anvil" (honest `Settled`, ghost `Refunded` timeout, swap `Refunded` mismatch with `provenCheats = 1`) |
| Coinbase facilitator path (`reserve()` then CDP settles) | **BLOCKED, unproven** | CDP facilitator answered `invalid_payload: contract call failed … execution reverted` for a treasury-as-payer authorization; settlement with a live `reserve()` was not proven; the demo uses the Overflow facilitator (docs/coinbase-feedback.md) |
| Sellers (`sim-seller-a`, `sim-seller-b`), their datasets and catalog (`data/catalog.json`, 6 listings) | **SIMULATED** (synthetic, redistributable) | `apps/service/src/sellers/`, `data/README.md` |
| Cheating sellers (swap, ghost behaviors) | **SIMULATED** | `SELLER_BEHAVIORS`, `apps/service/src/sellers/recourse/behavior.ts` (the `flow:demo` sellers); `apps/service/src/recourse/seller-sim.ts` (the local Anvil runner) |
| Attacker endpoint and address | **SIMULATED** (never allowlisted) | `ATTACKER_ADDRESS`, `/premium-intel` fixture |
| The company, Larkspur Research Partners, its departments and books | **SIMULATED** | `COMPANY_NAME` seed (docs/PROGRESS.md, database entry) |

## Prerequisites

- Node and pnpm (pnpm workspace; see `package.json`)
- Foundry (`forge`, `anvil`, `cast`)
- A Base Sepolia RPC URL (`BASE_SEPOLIA_RPC_URL`)
- For live runs only: Base Sepolia ETH (deployer, relayer, seller keys) and test USDC from https://faucet.circle.com, plus `ANTHROPIC_API_KEY` and `CLAUDE_MODEL`
- Postgres is optional: without `DATABASE_URL` the service uses PGlite (`PGLITE_DATA_DIR`)

## Setup, in order

```sh
git clone --recurse-submodules https://github.com/its-advait/Overflow   # contracts/lib are git submodules
cd Overflow
pnpm install
cp .env.example .env                       # fill in values; variable names only are listed there
cp apps/web/.env.example apps/web/.env.local
pnpm typecheck && pnpm build && pnpm test  # Vitest
pnpm contracts:build && pnpm contracts:test
pnpm contracts:invariant                   # invariant suites only
pnpm contracts:fork                        # fork suite against live Base Sepolia USDC (read-only)
pnpm demo:reset                            # service STOPPED: lists stale reservations with the POST /release command for each, moves the PGlite dir aside (never deletes), migrates, seeds the SIMULATED company, agents and catalog
pnpm dev                                   # web + service
pnpm demo:preflight                        # read-only green/red table: chain, contracts, treasury USDC, relayer and seller gas, keys, allowlist, service API, sellers, SSE, model API; exit 0 only if all green
pnpm demo:reset --behavior honest          # service RUNNING: sets both SIMULATED sellers' behavior; the database is left alone
```

`demo:reset` reuses the deployed contracts and never deploys; it refuses a Postgres `DATABASE_URL` (drop that database yourself). Stale reservations are not released automatically: the stopped-service run prints the commands (`apps/service/scripts/demo-reset.ts`). Recorded runs: docs/PROGRESS.md, "demo scripts and submission pack" (`demo:preflight` exit 1 with 4 red rows against a stale, unfunded service; `demo:reset` with the service stopped seeded "Larkspur Research Partners" (SIMULATED), 3 agents, 6 listings).

Deploy (already done; addresses in `packages/schemas/deployments/base-sepolia.json`):

```sh
DRY_RUN=1 pnpm contracts:deploy   # simulate, no broadcast
pnpm contracts:deploy             # broadcast + Basescan verify + export
pnpm contracts:export --abi-only  # regenerate packages/schemas/src/abi/*.ts
pnpm status                       # live treasury balance, owner, nodes, remaining()
pnpm dev:fund 12                  # DEV ONLY: deployer -> treasury USDC (the demo controller funds via Coinbase Wallet)
pnpm --filter @overflow/scripts dev-fund-gas   # DEV ONLY: deployer -> relayer ETH
```

Run the app:

```sh
pnpm dev                          # web (Next.js) + service in parallel
pnpm service                      # service only; boots after the USDC domain + deployments checks pass
```

Signing keys are read from Foundry keystores (`RELAYER_ACCOUNT` + `RELAYER_PASSWORD_FILE`, `AGENT_ROOT_ACCOUNT`, `DEPLOYER_ACCOUNT`) or 64-hex dev fallbacks; no key is printed or written. A node key can instead live in a Coinbase Developer Platform server account (`NODE_SIGNER=cdp`, `CDP_ACCOUNT_NAME`, optional `CDP_ACCOUNT_ADDRESS` pin); check it once with `pnpm --filter @overflow/payment-client cdp:sign-check -- --name overflow-node-root --json` (signs, verifies, broadcasts nothing).

## Pay from any agent (`overflow_pay`)

`packages/overflow-mcp` is a stdio MCP server that lets Claude Code, Claude Desktop or any MCP client pay x402 APIs under an Overflow node's policy. `overflow_budget()` reads the node's remaining USDC and per-call limit from the treasury; `overflow_quote(url)` fetches the 402 and asks the facilitator to simulate the payment (`POST /verify`, nothing broadcast); `overflow_pay(url, maxAmount)` signs one EIP-3009 authorization with `from` = the treasury, settled only by `OverflowTreasury.settle()`. Amounts are atomic USDC as decimal strings; floats are rejected. The server holds no owner key and never retries a payment.

```sh
pnpm mcp:build    # -> packages/overflow-mcp/dist/server.js
claude mcp add --transport stdio overflow -- node "$(pwd)/packages/overflow-mcp/dist/server.js"
```

It reads `SERVICE_URL`, `BASE_SEPOLIA_RPC_URL` and the node key (`NODE_PRIVATE_KEY`, `NODE_ACCOUNT` + `NODE_PASSWORD_FILE`, or `NODE_SIGNER=cdp`) from the repo `.env`. Claude Desktop setup, the refusal table and a 5-minute walkthrough (`/api/search` pays, `/premium-intel` is refused with `PayeeNotAllowed(0)`): [packages/overflow-mcp/README.md](packages/overflow-mcp/README.md).

## The controller (Coinbase Wallet MCP)

The treasury owner is the controller's Coinbase smart wallet; the owner key is on no server. Exceptions that need an owner action (new payee, cap raise, pause) become controller requests with prepared calldata. A Claude Code session with Wallet MCP (`claude mcp add --transport http --scope user base-mcp https://wallet-mcp.coinbase.com`) runs the `overflow-controller` skill (`.claude/skills/overflow-controller/SKILL.md`): it lists `GET /api/controller-requests`, sends each call with `send_calls` on `base-sepolia`, records `{requestId, approvalUrl}` at `POST /api/controller-requests/:id/submission`, and the human approves in Coinbase Wallet. A request becomes done only when the indexer stores the treasury event (`AllowSet`, `CapRaised`, `NodePaused` by the owner). `/controller` shows each request's state; `/agents` opens requests from the delegation tree. Details: [docs/controller.md](docs/controller.md).

## Local Anvil Recourse run (never Base Sepolia)

The three Recourse scenarios run end to end against the real contracts, facilitator path and indexer on a local Anvil fork; the runner refuses any RPC that is not Anvil.

```sh
bash scripts/anvil-up.sh                           # anvil --fork-url $BASE_SEPOLIA_RPC_URL --chain-id 84532
pnpm --filter @overflow/service anvil:provision    # deploys treasury + factory on the fork, createRoot, mints test USDC
set -a; source apps/service/.anvil/service.env; set +a
pnpm --filter @overflow/service dev                # boots, indexes, runs the three SIMULATED orders (RECOURSE_ANVIL_RUN=1)
```

Then `/escrow` lists the orders and `/escrow/[id]` shows the state diagram, terms, sample, evidence (both Merkle proofs re-verified in the browser) and the calls the contract would accept.

## 5-minute walkthrough

What a reviewer can run today without funds:

1. **Contracts (1 min).** `pnpm contracts:test`. Last recorded result: 20 suites, 196 passed, 0 failed, 1 skipped (docs/PROGRESS.md, "end-to-end purchase flow"). `pnpm contracts:fork` runs the USDC gate suite against live Base Sepolia USDC (7 passed, docs/PROGRESS.md "hardening pass").
2. **Offchain tests (1 min).** `pnpm test`. Last recorded results: exit 0, 87 files, 736 tests (docs/PROGRESS.md, 2026-10-25 entries); on the merged `main`, 91 files passed, 1 skipped, 747 tests passed, 1 skipped (docs/PROGRESS.md, "merge `origin/main` (web missions, web overview) into `main`").
3. **Live state (30 s).** `pnpm status` reads the real treasury on Base Sepolia (owner, balance, nodes, `remaining()`).
4. **UI (1.5 min).** `pnpm dev`, open http://localhost:3000. With `NEXT_PUBLIC_USE_MOCKS=1` the UI runs on labeled fixtures and shows a MOCK badge; with it unset the UI reads the service at `NEXT_PUBLIC_API_URL`. Every simulated party carries a SIMULATED label. Pages: Overview, Missions, Purchases, Agents (delegation tree), Escrow (list and detail), Ledger, Controller, Settings (the live control panel).

The live demo (needs funding; **not yet run**, see [docs/limitations.md](docs/limitations.md)):

```sh
pnpm demo:reset                                       # service stopped: fresh PGlite, seeded
RECOURSE_REVEAL_WINDOW_S=180 RECOURSE_CHALLENGE_WINDOW_S=60 pnpm --filter @overflow/service dev
pnpm demo:preflight                                   # expect every row green
pnpm --filter @overflow/service flow:demo --beat all  # honest -> SETTLED, ghost -> REFUNDED, swap -> REFUNDED by proof
pnpm --filter @overflow/service mission:run -- --budget 5
```

Scripted replay (labeled fallback; no recording exists yet): see [data/scripted/README.md](data/scripted/README.md).

## Live test and live demo

Overflow is proven with a LIVE test and a LIVE demo on Base Sepolia, with live transactions. Neither has run yet ([docs/limitations.md](docs/limitations.md)); each beat's evidence slot is filled with its Basescan link after the run.

| Beat | Expected onchain result | Evidence |
|---|---|---|
| Honest seller paid | escrow funded, key revealed, `accept()`, escrow `PaidOut` | Live tx: TODO (Basescan link after the live run) |
| Ghost seller (SIMULATED) | no key revealed; timeout refund restores treasury USDC, bond to the buyer | Live tx: TODO (Basescan link after the live run) |
| Swap seller (SIMULATED) | mismatch proof (`complainMismatch`): refund plus bond, seller flagged | Live tx: TODO (Basescan link after the live run) |
| Flagged seller opens a new order | refused with `PayeeFlagged` | Live tx: TODO (Basescan link after the live run) |
| Prompt-injected attacker payee (SIMULATED) | `settle()` refuses with `PayeeNotAllowed` | Live tx: TODO (Basescan link after the live run) |
| Sub-agent over its parent's cap | `settle()` refuses with `OverBudget` | Live tx: TODO (Basescan link after the live run) |
| Paused orchestrator | child payment refused with `Paused` | Live tx: TODO (Basescan link after the live run) |
| Direct-to-USDC bypass | USDC refuses with `FiatTokenV2: invalid signature`; nonce unused | Live tx: TODO (Basescan link after the live run) |
| Controller actions | the controller approves the policy change in Coinbase Wallet through Wallet MCP (caps, payees, pause); `/controller` shows DONE on the indexed event | Live tx: TODO (Basescan link after the live run) |
| An outside agent uses `overflow_pay` | `/api/search` settles through `treasury.settle()`; `/premium-intel` refused with `PayeeNotAllowed(0)` before signing | Live tx: TODO (Basescan link after the live run) |

## Built on Leash

Leash (our B@BHacks project, https://github.com/AnthonyOlakangil/leash) is prior work. It contributed the design of the treasury's `settle()` check order, the stateful ERC-1271 gate, gasless signed delegation, ancestor pause and the balance floor (docs/SPEC.md, "Security core carried over from Leash"). It is kept as a read-only reference in `reference/leash` (git-ignored, never imported). This repo's code was written during Cal Hacks 13.0.

## Docs

- [docs/architecture.md](docs/architecture.md): components, trust boundaries, the 10-step purchase flow, the three financial events
- [docs/limitations.md](docs/limitations.md): what is not done or not proven
- [docs/threat-model.md](docs/threat-model.md): attacks, defenses, tests and live evidence slots
- [docs/metrics.md](docs/metrics.md)
- [docs/DEMO.md](docs/DEMO.md)
- [docs/submission/](docs/submission/) (`docs/submission/*.md`, one per track)
- [docs/SPEC.md](docs/SPEC.md): build spec
- [docs/gas.md](docs/gas.md): gas per operation
- [docs/coinbase-feedback.md](docs/coinbase-feedback.md): Coinbase facilitator findings, the Wallet MCP controller and the CDP sign check
- [docs/controller.md](docs/controller.md): controller approvals through Coinbase Wallet MCP
- [packages/overflow-mcp/README.md](packages/overflow-mcp/README.md): the `overflow_pay` MCP server
- [docs/PROGRESS.md](docs/PROGRESS.md): progress log with real command output

## Layout

- `apps/web` Next.js App Router UI (Tailwind, shadcn/ui)
- `apps/service` Node service: `api/`, `orchestration/` (Claude agents), `facilitator/` (settle core), `sellers/` (SIMULATED x402 sellers and attack fixtures), `recourse/` (local Anvil Recourse runner, SIMULATED), `exceptions/` (controller requests), `chain/` (indexer), `ledger/`, `reconciliation/`
- `packages/*`: `schemas`, `oracle`, `fusion`, `payment-client` (including env, keystore and CDP signers), `recourse-crypto`, `database`, `datasets`, `overflow-mcp` (the `overflow_pay` MCP server)
- `.claude/skills/overflow-controller`: the controller's Wallet MCP skill
- `data`: SIMULATED datasets and seller catalog
- `contracts`: Foundry project (solc 0.8.28, cancun, OpenZeppelin 5)
- `scripts`: operator scripts
