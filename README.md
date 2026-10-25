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

## Payment adapters (`@overflow/payment-client`)

`OverflowFacilitatorAdapter` and `CoinbaseFacilitatorAdapter` implement the spec's `PaymentAdapter`
(`getPaymentRequirements`, `preparePayment`, `submitPayment`, `reconcilePayment`). Oracle, Fusion and the UI only
see a `PaymentStatus`. One authorization per purchase, ever; `reconcilePayment` is the only retry path and reads USDC's
`authorizationState` before anything else. `pnpm demo:adapters` runs one purchase through each on Base Sepolia
(`--probe-coinbase` only asks the Coinbase facilitator's `/verify` about a treasury-as-payer authorization).

## Layout

- `apps/web` Next.js App Router UI (Tailwind, shadcn/ui, lucide-react)
- `apps/service` Node service: `api/`, `orchestration/`, `facilitator/` (settle() core), `sellers/` (SIMULATED x402 APIs and attack fixtures on `SELLER_URL`; demo: `pnpm --filter @overflow/service sellers:demo`), `chain/`
- `packages/*` shared libraries: `schemas`, `oracle`, `fusion`, `payment-client`, `recourse-crypto`, `database`, `datasets`
- `data` SIMULATED datasets and seller catalog (`data/README.md`; regenerate with `pnpm datasets:generate`)
- `contracts` Foundry project (solc 0.8.28, cancun, OpenZeppelin 5)
- `scripts` operator scripts (`deploy.sh`, `export-deployment.ts`, `status.ts`, `dev-fund.ts`)
- `docs` spec, progress, changelog
