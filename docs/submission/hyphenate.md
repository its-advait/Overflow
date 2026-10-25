# Overflow for Hyphenate: Autonomous Systems for Finance

Status as of 2026-10-25. Every claim below cites a transaction, a file or a recorded run. Where nothing real exists yet, the text says TODO. SIMULATED parts are labeled.

## Seats

Procurement analyst and accounts-payable clerk for a company's AI-agent data spend.

- **Procurement (find, merge, request):** Oracle decides what is worth buying; Fusion merges compatible requests into one purchase (docs/SPEC.md, "Finance layer for Hyphenate").
- **Accounts payable (fund escrow, release, refund, book):** each order gets its own escrow contract; the seller is paid only after delivery checks pass, otherwise the treasury is refunded; every chain event is booked in a double-entry subledger (docs/SPEC.md, "Journal entries", "Reconciliation").

## The company (SIMULATED)

| Item | Value | Source |
|---|---|---|
| Company | **Larkspur Research Partners** (SIMULATED, fictional; `simulated: true` on the organization record; name can be overridden with `COMPANY_NAME`) | packages/database/src/seed.ts |
| What it does | A small research firm whose analysts run AI agents that buy market data | docs/SPEC.md, "Company and people" |
| Departments | `research`, `finance` | packages/database/src/seed.ts (`SEED_DEPARTMENTS`) |
| Agents (seeded) | Orchestrator (research, role `orchestrator`); Research analyst agent (research, `analyst`, child of the orchestrator); Finance analyst agent (finance, `analyst`, child of the orchestrator). Seed keys are SIMULATED stand-ins the service replaces with real agent addresses. | packages/database/src/seed.ts |
| Who it answers to | The controller (a human; the SPEC design uses a Coinbase Wallet), department heads who own budgets, and a read-only auditor. A model may play the department heads and auditor in the demo. | docs/SPEC.md, "Company and people" |
| What it buys | SIMULATED, synthetic, redistributable US EV-registration datasets from two SIMULATED sellers (`sim-seller-a` "Registry Data Co.", `sim-seller-b` "Mobility Insights"), 6 listings priced 4 to 13 USDC, licenses `company-use` or `single-user` | data/catalog.json |

## Real versus simulated

| Part | Real or SIMULATED | Evidence / status |
|---|---|---|
| OverflowTreasury on Base Sepolia (84532) | Real | `0x03805bde8bd8266ad525a9eb13a0eda7facadca2`, deploy tx [`0xbb9fd87f…301c`](https://sepolia.basescan.org/tx/0xbb9fd87f128ef5783b4765d4741001287acc4d495ee996fb9e8979db6c5b301c), block 50014188 (packages/schemas/deployments/base-sepolia.json) |
| OverflowEscrowFactory + escrow implementation | Real | factory `0x933bc257a24d94786d0021745470d343d3391808`, implementation `0x16fb922f0b3aa2c09d0e5e56640f7b0fd3e14f20`, tx [`0x17570db9…d20f`](https://sepolia.basescan.org/tx/0x17570db986b411cd99fd0f336627d23f8bb2298750537234d37d1955bb11d20f) (packages/schemas/deployments/base-sepolia.json) |
| USDC | Real testnet USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | The treasury holds **0 USDC** and the relayer **0 ETH** (docs/PROGRESS.md, "live P6.3 / P6.4 / P6.5 checks", 2026-10-25). No live payment has moved USDC through this treasury yet. |
| x402 quote, sign, settle | Real code; **not yet run live** | The agent signs EIP-3009 with `@overflow/payment-client` and the relayer submits `settle()` (packages/payment-client, apps/service/src/payment/overflow-adapter.ts). Live run on Base Sepolia: TODO, blocked on funding. |
| Claude agents (Anthropic SDK, model from `CLAUDE_MODEL`) | Real code; **live mission not run** | docs/PROGRESS.md, "Service boot, honest mission … Not run" |
| Escrow payout and refund | Real contracts, tested in Foundry; **no live Base Sepolia escrow or refund tx yet** | `pnpm contracts:test`: 20 suites, 196 passed, 0 failed, 1 skipped (docs/PROGRESS.md, end-to-end purchase flow entry). Live: TODO. |
| Double-entry ledger and reconciliation | Real code; books belong to a SIMULATED company | packages/database, `GET /api/reconciliation` (apps/service/scripts/flow-demo.ts header) |
| Seller catalog and datasets | SIMULATED | data/catalog.json (`"simulated": true`) |
| Cheating sellers (honest / swap / ghost) | SIMULATED | apps/service/src/sellers/recourse/ (`SellerBehaviorSchema`) |
| Attacker | SIMULATED (random address, no key exists, never allowlisted) | docs/PROGRESS.md, `ATTACKER_ADDRESS` |
| Controller approvals | Partly SIMULATED in this build | The recorded owner transactions were signed by the deployer (= owner) key through dev scripts, labeled "DEV ONLY … SIMULATES the controller" in docs/PROGRESS.md. Approval through Coinbase Wallet / Wallet MCP is not evidenced in docs/PROGRESS.md: TODO. |
| Scripted replay (labeled fallback) | Exists in code; **no recording exists** | docs/PROGRESS.md, "no recording exists" |

## Live test and live demo on Base Sepolia

Overflow is proven with a live test and a live demo on Base Sepolia, with live transactions. Expected outcome and "Caught by" come from docs/SPEC.md. **No live run has happened yet**, so every evidence slot is TODO; nothing in this table is a result.

| Live beat | Expected | Caught by | Evidence |
|---|---|---|---|
| Honest seller (SIMULATED) delivers | Escrow funded, key revealed, buyer accepts, `PaidOut` | Escrow | Live tx: TODO (Basescan link after the live run) |
| Ghost seller (SIMULATED) never reveals the key | Timeout refund to the treasury | Escrow | Live tx: TODO (Basescan link after the live run) |
| Swap seller (SIMULATED) swaps one chunk after sampling | Mismatch proof, refund plus bond, seller flagged | Escrow | Live tx: TODO (Basescan link after the live run) |
| A flagged seller opens a new order | `PayeeFlagged` | Treasury and factory | Live tx: TODO (Basescan link after the live run) |
| A prompt-injected listing tells the agent to pay the attacker (SIMULATED) | `PayeeNotAllowed` | Treasury | Live tx: TODO (Basescan link after the live run) |
| A sub-agent spends over its parent's cap | `OverBudget(parent)` | Tree walk | Live tx: TODO (Basescan link after the live run) |
| The orchestrator is paused and a child pays | `Paused(root)` | Tree walk | Live tx: TODO (Basescan link after the live run) |
| The same signature sent straight to USDC | `FiatTokenV2: invalid signature` | ERC-1271 gate | Live tx: TODO (Basescan link after the live run) |
| Controller actions (agent caps, new payee, pause) | Owner-only treasury txs signed by the controller | `onlyOwner` | Live tx: TODO (Basescan link after the live run) |

These behaviors also have Foundry tests that pass today, for example contracts/test/escrow/EscrowMismatch.t.sol and the flagged-seller cases in contracts/test/unit/TreasuryEscrowPayee.t.sol (`pnpm contracts:test`: 20 suites, 196 passed, 0 failed, 1 skipped; docs/PROGRESS.md). Tests are not a substitute for the live links above.

TODO: fund the deployer, treasury, relayer and SIMULATED seller keys, run the live test and live demo, and paste the Basescan links into this table.

## Segregation of duties

From docs/SPEC.md ("Segregation of duties"), with the evidence that exists today.

| Action | Requested by | Approved by | Enforced by | Evidence |
|---|---|---|---|---|
| Buy within budget from an approved seller | Agent | Policy the controller set earlier | Treasury `settle()` or `reserve()` | Live settle and live refusals (attacker payee, over-cap sub-agent, paused orchestrator) on Base Sepolia: Live tx: TODO (Basescan link after the live run) |
| Add a new seller or payee | Agent | Controller in Coinbase Wallet | `onlyOwner` plus Wallet MCP approval | Real owner `setAllow(true)` tx on Base Sepolia: [`0xaf7ebf3eba341c67800b19ae09b61d6f0623969143d3733ee79c3364d8efb4bb`](https://sepolia.basescan.org/tx/0xaf7ebf3eba341c67800b19ae09b61d6f0623969143d3733ee79c3364d8efb4bb), block 49958800 (docs/PROGRESS.md). Caveats: signed by the deployer (= owner) key through the DEV ONLY `allow-payee` script, which SIMULATES the controller, not through Coinbase Wallet; and it targets the earlier treasury `0xd3a74fa9…8291`, since replaced by `0x0380…dca2`. Wallet MCP approval: TODO |
| Raise a budget | Agent or department head | Controller | `raiseCap`, owner only | TODO (no live `raiseCap` tx recorded) |
| Release escrow early | Buying agent (`accept`) | Recourse checks passed | Escrow contract | `OverflowEscrow.accept` (contracts/src/OverflowEscrow.sol), Foundry tests in contracts/test/escrow/OverflowEscrow.t.sol. Live: TODO |
| Refund | Anyone, after a deadline or with a proof | Contract rules | Escrow contract | `claimTimeoutRefund`, `complainMismatch`, `complainPromise` (contracts/src/OverflowEscrow.sol), Foundry tests in contracts/test/escrow/ (OverflowEscrow, EscrowMismatch, EscrowPromise). Live: TODO |
| Change any policy | Only the controller | — | The owner key is on no server | Owner-only setup on the current treasury: `setEscrowFactory` [`0x292d0e3cdce7cde3715afee886fcbdeab95fac62668f2a6c7733daba92b5e948`](https://sepolia.basescan.org/tx/0x292d0e3cdce7cde3715afee886fcbdeab95fac62668f2a6c7733daba92b5e948) and `createRoot` [`0x4aea260876dc3cfa33bdedbebd4791a7550d39f3349229656693a870abf9f7b2`](https://sepolia.basescan.org/tx/0x4aea260876dc3cfa33bdedbebd4791a7550d39f3349229656693a870abf9f7b2) (packages/schemas/deployments/base-sepolia.json). Caveat: in this hackathon build the owner key is held in the dev environment (`DEPLOYER_PRIVATE_KEY`, docs/PROGRESS.md), so "on no server" is the design target, not yet true |

"The agent that requests a payment can never approve its own policy change" (docs/SPEC.md). In contracts/src/OverflowTreasury.sol, `raiseCap` and `setAllow` are `onlyOwner`.

Checked at writing time with `eth_getTransactionReceipt` on the public Base Sepolia RPC: `0xaf7e…bb4bb` status 0x1, block 49958800, from the owner `0xb6f4…06c3` to `0xd3a7…8291`; `0x292d…e948` and `0x4aea…f7b2` status 0x1, block 50014188, from the owner to the treasury `0x0380…dca2`.

## The moment

**Planned beat** (docs/SPEC.md, Track map and Demo script): a SIMULATED seller swaps one record after the buyer sampled it. The buying agent submits a chunk (mismatch) proof to the order's escrow; the escrow refunds the treasury plus the seller's bond; the ledger reverses the entry; the seller is flagged and blocked on every later order.

| Event | Transaction |
|---|---|
| Escrow funded (USDC leaves the treasury for the order's escrow) | Live tx: TODO (Basescan link after the live run) |
| Mismatch proof accepted, refund plus bond to the treasury | Live tx: TODO (Basescan link after the live run) |
| Flagged seller's new order rejected (`PayeeFlagged`) | Live tx: TODO (Basescan link after the live run) |

Why it is TODO: the live missions (honest, ghost, swap) were not run because the treasury holds 0 USDC and the relayer 0 ETH (docs/PROGRESS.md, 2026-10-25 "Not done: no transaction was sent").

To produce it (docs/PROGRESS.md "To unblock", apps/service/scripts/flow-demo.ts): fund the deployer from faucets, `pnpm dev:fund 12`, fund seller bonds and gas, `preflight --budget 5` with 0 FAIL, start the service, then `pnpm --filter @overflow/service flow:demo -- --beat swap`. The beat expects REFUNDED (mismatch) proven onchain and `GET /api/reconciliation` with no open exception. Paste the escrow-funding and refund tx links here.

## Judge's guide: Settings, the live control panel

The SPEC asks for Settings controls a judge can change live, with no code change: seller behavior (honest, swap, ghost), price, agent caps, a new payee, and a license flag (docs/SPEC.md, "A judge's own scenario"). Settings (`/settings`, apps/web/src/app/settings/page.tsx) is the live control panel for exactly these five controls.

| Control (SPEC) | Live effect | Live tx / result |
|---|---|---|
| Seller behavior: honest / swap / ghost | Changes what the SIMULATED seller does on the next order (the SIMULATED seller API `PUT /sellers/:id/behavior`, apps/service/src/sellers/recourse/routes.ts). The next order ends paid out, refunded on timeout, or refunded by mismatch proof with the seller flagged. | Live tx / result: TODO |
| Price | Changes the price the SIMULATED seller quotes on its next order. The payment still has to pass the treasury's per-call and budget checks. | Live tx / result: TODO |
| Agent caps | A treasury policy change the controller signs onchain (`raiseCap`, owner only). | Live tx / result: TODO |
| A new payee | A treasury policy change the controller signs onchain (`setAllow`, owner only). An earlier real `setAllow` tx is cited under "Segregation of duties". | Live tx / result: TODO |
| License flag | Changes the SIMULATED listing's license (`company-use` or `single-user`), which decides whether Fusion may merge two requests into one purchase (a single-user license is never merged). | Live tx / result: TODO |

Command-line equivalents also exist: `flow:demo --beat honest|ghost|swap|all` and `pnpm demo:reset --behavior honest|swap|ghost` (apps/service/scripts/demo-reset.ts) set the SIMULATED sellers through the same seller API, and the DEV ONLY `pnpm --filter @overflow/scripts allow-payee <address…>` signs `setAllow` with the owner key (SIMULATES the controller).

Web pages: Overview (`/`), Missions (`/missions`, `/missions/[id]`), Purchases (`/purchases`, `/purchases/[id]`), Ledger (`/ledger`), Settings (`/settings`, the live control panel). Stub pages today: Agents, Escrow, Activity (Blocked lane).

## TODO before submission

- [ ] Fund deployer, treasury, relayer and SIMULATED seller keys; run honest, ghost and swap beats live; paste escrow and refund tx links into "The moment".
- [ ] Run the live test and live demo beats on Base Sepolia and paste each Basescan link into "Live test and live demo on Base Sepolia".
- [ ] Controller approval through Coinbase Wallet / Wallet MCP, with one real tx link.
- [ ] Exercise each Settings control live and fill in its "Live tx / result" slot.
- [ ] Record the scripted replay fallback (no recording exists).
