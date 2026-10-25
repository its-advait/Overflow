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
| Coinbase facilitator path (`reserve()` then CDP settles) | **BLOCKED, unproven** | CDP facilitator answered `invalid_payload: contract call failed … execution reverted` for a treasury-as-payer authorization; settlement with a live `reserve()` was not proven; the demo uses the Overflow facilitator (docs/coinbase-feedback.md) |
| Sellers (`sim-seller-a`, `sim-seller-b`), their datasets and catalog (`data/catalog.json`, 6 listings) | **SIMULATED** (synthetic, redistributable) | `apps/service/src/sellers/`, `data/README.md` |
| Cheating sellers (swap, ghost behaviors) | **SIMULATED** | `SELLER_BEHAVIORS`, `apps/service/src/sellers/recourse/behavior.ts` |
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

Signing keys are read from Foundry keystores (`RELAYER_ACCOUNT` + `RELAYER_PASSWORD_FILE`, `AGENT_ROOT_ACCOUNT`, `DEPLOYER_ACCOUNT`) or 64-hex dev fallbacks; no key is printed or written.

## The controller (Coinbase Wallet MCP)

The treasury owner is the controller's Coinbase smart wallet; the owner key is on no server. A Claude Code session
with Wallet MCP connected (`claude mcp add --transport http --scope user base-mcp https://wallet-mcp.coinbase.com`)
runs the `overflow-controller` skill: it lists `GET /api/controller-requests`, sends each prepared call with
`send_calls` on `base-sepolia`, records `{requestId, approvalUrl}` at `POST /api/controller-requests/:id/submission`,
shows the approval URL, and checks `get_request_status` once the human approved. A request becomes DONE only when
the indexer stores the treasury event. Details: `docs/controller.md`; live results: `docs/coinbase-feedback.md`.
UI: `pnpm --filter @overflow/web dev` then `/agents` (the delegation tree: live budgets from the treasury's view calls, the
per-agent menu that opens controller requests, a side panel of payments and refusals; `NEXT_PUBLIC_USE_MOCKS=1` swaps in a
labelled SIMULATED treasury) and `/controller` (every request and its approval state). The typed client reads
`NEXT_PUBLIC_API_URL` (see `apps/web/.env.example`); the older `/controller` page still reads `NEXT_PUBLIC_SERVICE_URL`.

## 5-minute walkthrough

What a reviewer can run today without funds:

1. **Contracts (1 min).** `pnpm contracts:test`. Last recorded result: 20 suites, 196 passed, 0 failed, 1 skipped (docs/PROGRESS.md, "end-to-end purchase flow"). `pnpm contracts:fork` runs the USDC gate suite against live Base Sepolia USDC (7 passed, docs/PROGRESS.md "hardening pass").
2. **Offchain tests (1 min).** `pnpm test`. Last recorded result: exit 0, 87 files, 736 tests (docs/PROGRESS.md, 2026-10-25 entries).
3. **Live state (30 s).** `pnpm status` reads the real treasury on Base Sepolia (owner, balance, nodes, `remaining()`).
4. **UI (1.5 min).** `pnpm dev`, open http://localhost:3000. With `NEXT_PUBLIC_USE_MOCKS=1` the UI runs on labeled fixtures and shows a MOCK badge; with it unset the UI reads the service at `NEXT_PUBLIC_API_URL`. Every simulated party carries a SIMULATED label.

The live demo (needs funding; **not yet run**, see [docs/limitations.md](docs/limitations.md)):

```sh
pnpm demo:reset                                       # service stopped: fresh PGlite, seeded
RECOURSE_REVEAL_WINDOW_S=180 RECOURSE_CHALLENGE_WINDOW_S=60 pnpm --filter @overflow/service dev
pnpm demo:preflight                                   # expect every row green
pnpm --filter @overflow/service flow:demo --beat all  # honest -> SETTLED, ghost -> REFUNDED, swap -> REFUNDED by proof
pnpm --filter @overflow/service mission:run -- --budget 5
```

Scripted replay (labeled fallback; no recording exists yet): see [data/scripted/README.md](data/scripted/README.md).

## Local Anvil recourse demo (never Base Sepolia)

The three recourse scenarios from the spec (honest seller paid, ghost seller timed out, swap seller caught by a Merkle proof) run end to end against the real contracts on a local Anvil fork of Base Sepolia. Nothing here broadcasts to the live chain: the fork reads Base Sepolia through `BASE_SEPOLIA_RPC_URL` and keeps every transaction local.

```sh
pnpm contracts:build                               # artifacts in contracts/out
bash scripts/anvil-up.sh                           # anvil --fork-url $BASE_SEPOLIA_RPC_URL --chain-id 84532 (ANVIL_FORK_BLOCK pins the block)
pnpm --filter @overflow/service anvil:provision    # deploys treasury + factory on the fork, createRoot, mints test USDC, writes apps/service/.anvil/
set -a; source apps/service/.anvil/service.env; set +a
pnpm --filter @overflow/service dev                # boots, indexes, then runs the three SIMULATED orders (RECOURSE_ANVIL_RUN=1)
```

Judge controls (docs/SPEC.md "A judge's own scenario") work on the same fork with no code change and need only the seller keys from `service.env`, not `RECOURSE_ANVIL_RUN`: `GET /api/settings/sellers` lists the three SIMULATED sellers and the behaviour each plays on its next order, `PUT /api/settings/sellers/<address> {"behaviour":"ghost"}` changes it (in memory; a restart resets to honest, ghost, swap), `POST /api/settings/orders {"sellerAddress":…,"listingId":…}` runs one order now and answers the runner's steps and tx hashes (the purchase and escrow status come from the indexer: `GET /api/escrow/<purchaseId>`), `PUT /api/resources/<id> {"priceAtomic"|"license"|"seats"}` edits a SIMULATED listing so the next Oracle/Fusion run and the next order read the new values, and `GET /api/settings/network` reads the treasury's owner, floor, reservation window and the USDC domain from the chain. A seller the factory has flagged is refused at `create` (`SellerFlagged`) and the purchase is closed REJECTED. Every ghost order moves the fork's clock 1800 s forward. In the web app, `/settings` exposes the same controls: seller behaviour and "run one order" (statuses read back from the indexer), listing price and license, a Fusion check over the recorded decisions, cap and payee requests, and the network facts.

The same provisioning readies the two attack demos on the fork: it allowlists the SIMULATED search and scrape payees (never the SIMULATED attacker), writes `AGENT_KEYS`, `ATTACKER_ADDRESS`, `DEMO_PAYEE_ADDRESS` and `DEMO_MODE=true` with a fresh `DEMO_TOKEN` into `service.env`. With `CLAUDE_MODEL` set in the shell (the service reads `ANTHROPIC_API_KEY` from `.env`; a shell variable of that name wins over `.env`, so unset a stale one), `pnpm --filter @overflow/service mission:run -- --force-injection-beat --root-node 1` runs a mission whose `/premium-intel` attempt reverts onchain (locally) with `PayeeNotAllowed(0)`, and `pnpm demo:facilitator` sends the bypass straight to USDC; both refusals land in `GET /api/activity?kind=policy.blocked` and the web app's Blocked lane (`/activity?view=blocked`). `--root-node 1` is needed on a fresh fork because the seeded orchestrator has no node there. Anvil mines only on a transaction, so after a quiet minute the latest block is stale and a fresh authorization reads as "not yet valid"; mine an empty block (`evm_mine`) or keep one mined every few seconds while you run the demos. `pnpm demo:facilitator` writes `docs/demo-facilitator.md` with Basescan links that do not resolve for a fork; delete it after a local run.

In the web app, `/activity` is the audit view: every event newest first (time, type, agent, action, amount, counterparty, tx), filterable by mission, agent and type in the URL, live over `/events`. `/activity?view=blocked` is the Blocked lane: each refused payment with its decoded revert, what it means, where it was refused (simulation, onchain revert, USDC, before signing), its transaction and authorization digest. A row opens a drawer with the source reference (transaction and the indexed logs with their log index, the digest, the Oracle's prompt and output hashes) and the related purchase.

Then `GET /api/escrow` lists the orders and `GET /api/escrow/:id` shows each one's terms, live chain state, chain events, the pre-funding sample with its rule-based judgment, the complaint with both proofs, and which escrow calls the contract would accept right now. The run refuses any RPC that does not answer `anvil_nodeInfo`, so `RECOURSE_ANVIL_RUN=1` against Base Sepolia only logs a refusal. Keys in `service.env` are Anvil's public dev accounts; the file is gitignored.

In the web app, `/escrow` lists the orders and `/escrow/<purchase id or address>` is the judge's page: state diagram, terms with live countdowns, the sample, the evidence (both Merkle proofs re-verified in the browser) and the calls the contract would accept. Point it at the service with `NEXT_PUBLIC_API_URL=http://localhost:4000` (or `NEXT_PUBLIC_USE_MOCKS=1` for the golden-vector fixtures).

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
| Controller actions | the controller signs the policy change onchain (caps, payees, pause) | Live tx: TODO (Basescan link after the live run) |

## Docs

- [docs/architecture.md](docs/architecture.md): components, trust boundaries, the 10-step purchase flow, the three financial events
- [docs/limitations.md](docs/limitations.md): what is not done or not proven
- [docs/threat-model.md](docs/threat-model.md): attacks, defenses, tests and live evidence slots
- [docs/metrics.md](docs/metrics.md)
- [docs/DEMO.md](docs/DEMO.md)
- [docs/submission/](docs/submission/) (`docs/submission/*.md`, one per track)
- [docs/SPEC.md](docs/SPEC.md): build spec
- [docs/gas.md](docs/gas.md): gas per operation
- [docs/coinbase-feedback.md](docs/coinbase-feedback.md): Coinbase facilitator findings
- [docs/PROGRESS.md](docs/PROGRESS.md): progress log with real command output

## MCP server for any agent (`@overflow/overflow-mcp`)

`packages/overflow-mcp` is a stdio MCP server with `overflow_budget`, `overflow_quote` (402 + the facilitator's `/verify`
simulation) and `overflow_pay` (one EIP-3009 authorization, `from = treasury`, settled only by `settle()`). Install:
`pnpm mcp:build && claude mcp add --transport stdio overflow -- node "$(pwd)/packages/overflow-mcp/dist/server.js"`.
The package README has the Claude Desktop config, a 5-minute walkthrough and the refusal table.

## Layout

- `apps/web` Next.js App Router UI (Tailwind, shadcn/ui)
- `apps/service` Node service: `api/`, `orchestration/` (Claude agents), `facilitator/` (settle core), `sellers/` (SIMULATED x402 sellers and attack fixtures), `chain/` (indexer), `ledger/`, `reconciliation/`
- `packages/*`: `schemas`, `oracle`, `fusion`, `payment-client`, `recourse-crypto`, `database`, `datasets`
- `data`: SIMULATED datasets and seller catalog
- `contracts`: Foundry project (solc 0.8.28, cancun, OpenZeppelin 5)
- `scripts`: operator scripts
