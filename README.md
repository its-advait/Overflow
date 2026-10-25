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
pnpm contracts:invariant          # invariant suites only (256 runs x depth 50)
pnpm contracts:fork               # fork suite against live Base Sepolia USDC (needs BASE_SEPOLIA_RPC_URL; read-only)
pnpm contracts:gas                # regenerate docs/gas.md
```

Optional read-only reference (git-ignored, never imported):

```sh
git clone --depth 1 https://github.com/AnthonyOlakangil/leash reference/leash
```

## Deploy to Base Sepolia

```sh
# .env: BASE_SEPOLIA_RPC_URL, BASESCAN_API_KEY, OWNER_ADDRESS, AGENT_ROOT_ADDRESS (or AGENT_ROOT_KEY as an address),
#       DEPLOYER_ACCOUNT (Foundry keystore name), DEPLOYER_PASSWORD_FILE (chmod 600), DEPLOYER_ADDRESS
DRY_RUN=1 pnpm contracts:deploy   # simulate with --sender, no broadcast
pnpm contracts:deploy             # broadcast + Basescan verify + export (prompts for the keystore password if no password file)
pnpm contracts:export --abi-only  # regenerate packages/schemas/src/abi/*.ts from contracts/out
pnpm status                       # live treasury balance, owner, TOKEN, floor, nodes and remaining()
pnpm dev:fund 5                   # DEV ONLY: move 5 USDC deployer -> treasury (the demo controller funds via Coinbase Wallet)
```

`contracts/script/Deploy.s.sol` deploys `OverflowTreasury(TOKEN_ADDRESS, OWNER_ADDRESS)`. When the owner is the deployer it also calls `createRoot(AGENT_ROOT_ADDRESS, ROOT_CAP, ROOT_MAX_PER_CALL, ROOT_EXPIRY)`; otherwise it prints the `createRoot` calldata for the controller to approve. Addresses land in `packages/schemas/deployments/base-sepolia.json` (`BASE_SEPOLIA_DEPLOYMENT`, `loadDeployments()`) and ABIs in `packages/schemas/src/abi/` (`overflowTreasuryAbi`). No private key is ever read: signing goes through a Foundry keystore.

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

## Run the facilitator (service)

```bash
pnpm service                      # tsx watch apps/service: boots only after the USDC domain + deployments checks pass
curl localhost:4000/health        # relayer address, ETH balance, queue; GET /supported, POST /verify|/settle|/reserve|/release|/delegate|/pause-child, GET /events (SSE)
pnpm demo:facilitator             # Base Sepolia proof: settle, PayeeNotAllowed landed onchain, bypass rejected by USDC, 409 replay -> docs/demo-facilitator.md
```

Signing: the service decrypts a Foundry keystore in memory at boot (`RELAYER_ACCOUNT=overflow-relayer` plus
`RELAYER_PASSWORD_FILE`, a chmod-600 file); `RELAYER_PRIVATE_KEY` may hold just the relayer's address, which the
decrypted key must match. A 64-hex `RELAYER_PRIVATE_KEY` is the dev fallback. The relayer holds gas ETH only, never
USDC. The demo script signs the same way with `AGENT_ROOT_ACCOUNT=overflow-agent-root` + `AGENT_ROOT_PASSWORD_FILE`
(or a 64-hex `AGENT_ROOT_KEY`), and also needs `DEMO_MODE=true`, `DEMO_TOKEN`, `DEMO_PAYEE_ADDRESS`,
`ATTACKER_ADDRESS`. No key is ever printed, exported or written. There are no `/admin` routes: owner actions go
through the controller.

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

## Payment adapters (`@overflow/payment-client`)

`OverflowFacilitatorAdapter` and `CoinbaseFacilitatorAdapter` implement the spec's `PaymentAdapter`
(`getPaymentRequirements`, `preparePayment`, `submitPayment`, `reconcilePayment`). Oracle, Fusion and the UI only
see a `PaymentStatus`. One authorization per purchase, ever; `reconcilePayment` is the only retry path and reads USDC's
`authorizationState` before anything else. `pnpm demo:adapters` runs one purchase through each on Base Sepolia
(`--probe-coinbase` only asks the Coinbase facilitator's `/verify` about a treasury-as-payer authorization).

## MCP server for any agent (`@overflow/overflow-mcp`)

`packages/overflow-mcp` is a stdio MCP server with `overflow_budget`, `overflow_quote` (402 + the facilitator's `/verify`
simulation) and `overflow_pay` (one EIP-3009 authorization, `from = treasury`, settled only by `settle()`). Install:
`pnpm mcp:build && claude mcp add --transport stdio overflow -- node "$(pwd)/packages/overflow-mcp/dist/server.js"`.
The package README has the Claude Desktop config, a 5-minute walkthrough and the refusal table.

## Layout

- `apps/web` Next.js App Router UI (Tailwind, shadcn/ui, lucide-react)
- `apps/service` Node service: `api/`, `orchestration/`, `facilitator/` (settle() core), `sellers/` (SIMULATED x402 APIs and attack fixtures on `SELLER_URL`; demo: `pnpm --filter @overflow/service sellers:demo`), `chain/`
- `packages/*` shared libraries: `schemas`, `oracle`, `fusion`, `payment-client`, `recourse-crypto`, `database`, `datasets`
- `data` SIMULATED datasets and seller catalog (`data/README.md`; regenerate with `pnpm datasets:generate`)
- `contracts` Foundry project (solc 0.8.28, cancun, OpenZeppelin 5)
- `scripts` operator scripts (`deploy.sh`, `export-deployment.ts`, `status.ts`, `dev-fund.ts`)
- `docs` spec, progress, changelog
