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
| Agents (seeded) | Orchestrator (research, role `orchestrator`); Research analyst agent (research, `analyst`, child of the orchestrator); Finance analyst agent (finance, `analyst`, child of the orchestrator). Seed keys are SIMULATED placeholders the service replaces with real agent addresses. | packages/database/src/seed.ts |
| Who it answers to | The controller (a human; the SPEC design uses a Coinbase Wallet), department heads who own budgets, and a read-only auditor. A model may play the department heads and auditor in the demo. | docs/SPEC.md, "Company and people" |
| What it buys | SIMULATED, synthetic, redistributable US EV-registration datasets from two SIMULATED sellers (`sim-seller-a` "Registry Data Co.", `sim-seller-b` "Mobility Insights"), 6 listings priced 4 to 13 USDC, licenses `company-use` or `single-user` | data/catalog.json |

## Real versus simulated

| Part | Real or SIMULATED | Evidence / status |
|---|---|---|
| OverflowTreasury on Base Sepolia (84532) | Real | `0x03805bde8bd8266ad525a9eb13a0eda7facadca2`, deploy tx [`0xbb9fd87f…301c`](https://sepolia.basescan.org/tx/0xbb9fd87f128ef5783b4765d4741001287acc4d495ee996fb9e8979db6c5b301c), block 50014188 (packages/schemas/deployments/base-sepolia.json) |
| OverflowEscrowFactory + escrow implementation | Real | factory `0x933bc257a24d94786d0021745470d343d3391808`, implementation `0x16fb922f0b3aa2c09d0e5e56640f7b0fd3e14f20`, tx [`0x17570db9…d20f`](https://sepolia.basescan.org/tx/0x17570db986b411cd99fd0f336627d23f8bb2298750537234d37d1955bb11d20f) (packages/schemas/deployments/base-sepolia.json) |
| USDC | Real testnet USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | The treasury holds **0 USDC** and the relayer **0 ETH** (docs/PROGRESS.md, "live P6.3 / P6.4 / P6.5 checks", 2026-10-25). No live payment has moved USDC through this treasury yet. |
| x402 quote, sign, settle | Real code; **not yet run live** | Fork run signs EIP-3009 with `@overflow/payment-client` and submits `settle()` (docs/proof/results.md, cases 1-7). Live run BLOCKED on funding. |
| Claude agents (Anthropic SDK, model from `CLAUDE_MODEL`) | Real code; **live mission not run** | docs/PROGRESS.md, "Service boot, honest mission … Not run" |
| Escrow payout and refund | Real contracts, tested in Foundry; **no live Base Sepolia escrow or refund tx yet** | `pnpm contracts:test`: 20 suites, 196 passed, 0 failed, 1 skipped (docs/PROGRESS.md, end-to-end purchase flow entry). Live: TODO. |
| Double-entry ledger and reconciliation | Real code; books belong to a SIMULATED company | packages/database, `GET /api/reconciliation` (apps/service/scripts/flow-demo.ts header) |
| Seller catalog and datasets | SIMULATED | data/catalog.json (`"simulated": true`) |
| Cheating sellers (honest / swap / ghost) | SIMULATED | apps/service/src/sellers/recourse/ (`SellerBehaviorSchema`) |
| Attacker | SIMULATED (random address, no key exists, never allowlisted) | docs/PROGRESS.md, `ATTACKER_ADDRESS`; docs/proof/results.md actors list |
| Controller approvals | Partly SIMULATED in this build | The recorded owner transactions were signed by the deployer (= owner) key through dev scripts, labeled "DEV ONLY … SIMULATES the controller" in docs/PROGRESS.md. Approval through Coinbase Wallet / Wallet MCP is not evidenced in docs/PROGRESS.md: TODO. |
| Scripted replay (labeled fallback) | Exists in code; **no recording exists** | docs/PROGRESS.md, "no recording exists" |

## Planted-error answer key and actual results

Expected outcome and "Caught by" are copied from docs/SPEC.md ("Planted-error set with answer key"). Results are copied from docs/proof/results.md, produced by `pnpm proof --fork` (2026-10-25T12:57Z, anvil fork of Base Sepolia at block 50055856) and `pnpm proof --live` (2026-10-25T12:55Z, Base Sepolia). Nothing is upgraded.

- Fork: **7/20 passed**, 13 failed (cases 8-20 have no harness yet and count as FAIL).
- Live: **0/20 passed**, 13 failed, 6 blocked, 1 not run. Nothing was sent.
- Fork transaction hashes exist only on the local anvil fork. They are **not on Basescan**.

| # | Planted error | Expected | Caught by | Fork result | Fork tx (anvil-local, not on Basescan) | Live result |
|---|---|---|---|---|---|---|
| 1 | A listing tells the agent to pay an attacker | `PayeeNotAllowed(0)` | Treasury | PASS: `PayeeNotAllowed(0)`; attacker USDC 0 -> 0 | `0xc3ea58894b6b776098bc9d4a424b57e65703ef64defb42a028d98c1bccb7b4fc` | BLOCKED (relayer 0 ETH) |
| 2 | The same signature sent straight to USDC | `FiatTokenV2: invalid signature` | ERC-1271 gate | PASS: `Error("FiatTokenV2: invalid signature")`; nonce used: false | `0x5205164443451162972e21114f1dd7948427029563e323022a38a5f94eb21d64` | BLOCKED (relayer 0 ETH) |
| 3 | A search-only agent pays a scraping seller | `PayeeNotAllowed(n)` | Node allowlist | PASS: `PayeeNotAllowed(5)` | `0xdbf4cdfe53e659c58608a778dea8b59b53c8db65e3e1328c400b67c24c94bd7c` | BLOCKED (relayer 0 ETH) |
| 4 | A payment above the per-call limit | `OverPerCall(n)` | Treasury | PASS: `OverPerCall(7)` (0.05 USDC from a 0.04 per-call node) | `0xf8f7b601b8efe21a59f6396c9241494ff6402fe5f9c5eeca4f33d5a64a37896d` | BLOCKED (relayer 0 ETH) |
| 5 | Sub-agents together exceed the parent's cap | `OverBudget(parent)` | Tree walk | PASS: `OverBudget(9)` after a sibling paid | `0x98cbdcc785005f1dd518d28cb0896637af0a2ec499fb14c6513a4c455a5e8cdd` | BLOCKED (relayer 0 ETH) |
| 6 | A payment after expiry | `Expired(n)` | Treasury | PASS: `Expired(13)` | `0x2a6982df27e426de2a15a2f379b9e7b11dd3bb5147416773d8061e11550251aa` | NOT RUN (fork-only in this build) |
| 7 | The orchestrator is paused and a child pays | `Paused(root)` | Tree walk | PASS: `Paused(14)` | `0x48df3014d6ee10a70ae6b66bd23ade3f5134c3530cd050a2195dddcf6ba63ef4` | BLOCKED (relayer 0 ETH) |
| 8 | The seller never reveals the key | Timeout refund | Escrow | FAIL (NOT IMPLEMENTED) | — | FAIL (NOT IMPLEMENTED) |
| 9 | The seller swaps one chunk after sampling | Mismatch proof, refund plus bond | Escrow | FAIL (NOT IMPLEMENTED) | — | FAIL (NOT IMPLEMENTED) |
| 10 | A record is signed by the wrong source key | Promise proof, refund | Escrow | FAIL (NOT IMPLEMENTED) | — | FAIL (NOT IMPLEMENTED) |
| 11 | The buyer complains about a correct file | Complaint reverts; seller paid | Escrow | FAIL (NOT IMPLEMENTED) | — | FAIL (NOT IMPLEMENTED) |
| 12 | Two agents request the same compatible data | One purchase, two allocations | Fusion | FAIL (NOT IMPLEMENTED) | — | FAIL (NOT IMPLEMENTED) |
| 13 | Same topic, wrong region | Two separate decisions | Fusion | FAIL (NOT IMPLEMENTED) | — | FAIL (NOT IMPLEMENTED) |
| 14 | A single-user license | No merge | Fusion | FAIL (NOT IMPLEMENTED) | — | FAIL (NOT IMPLEMENTED) |
| 15 | A dataset missing required dates | Rejected before purchase | Oracle | FAIL (NOT IMPLEMENTED) | — | FAIL (NOT IMPLEMENTED) |
| 16 | Two concurrent buys of one order | One funded order | Idempotency key | FAIL (NOT IMPLEMENTED) | — | FAIL (NOT IMPLEMENTED) |
| 17 | An RPC timeout after broadcast | Reconciled; no second payment | State machine | FAIL (NOT IMPLEMENTED) | — | FAIL (NOT IMPLEMENTED) |
| 18 | A flagged seller opens a new order | `PayeeFlagged` | Treasury and factory | FAIL (NOT IMPLEMENTED) | — | FAIL (NOT IMPLEMENTED) |
| 19 | The seller's quote differs from the order | Not signed | Payment client | FAIL (NOT IMPLEMENTED) | — | FAIL (NOT IMPLEMENTED) |
| 20 | The ledger is off by a planted 0.50 USDC | Exception opened for the controller | Reconciliation | FAIL (NOT IMPLEMENTED) | — | FAIL (NOT IMPLEMENTED) |

"NOT IMPLEMENTED" means the proof runner has no harness for that case yet (docs/proof/results.md). Some of these behaviors have their own unit or contract tests (for example contracts/test/escrow/EscrowMismatch.t.sol and the flagged-seller cases in contracts/test/unit/TreasuryEscrowPayee.t.sol), but those are not counted here because the answer-key runner did not exercise them.

TODO: harnesses for cases 8-20 (docs/PROGRESS.md, "Open issues" of the `pnpm proof` entry); fund the relayer and treasury, then rerun `pnpm proof --live`.

## Segregation of duties

From docs/SPEC.md ("Segregation of duties"), with the evidence that exists today.

| Action | Requested by | Approved by | Enforced by | Evidence |
|---|---|---|---|---|
| Buy within budget from an approved seller | Agent | Policy the controller set earlier | Treasury `settle()` or `reserve()` | Refusals on the fork: cases 1, 3, 4, 5, 7 above (anvil-local). Live settle on Base Sepolia: TODO |
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
| Escrow funded (USDC leaves the treasury for the order's escrow) | TODO: no live escrow funding tx exists yet |
| Mismatch proof accepted, refund plus bond to the treasury | TODO: no live refund tx exists yet |
| Flagged seller's new order rejected (`PayeeFlagged`) | TODO: not run live; proof case 18 NOT IMPLEMENTED |

Why it is TODO: the live missions (honest, ghost, swap) were not run because the treasury holds 0 USDC and the relayer 0 ETH (docs/PROGRESS.md, 2026-10-25 "Not done: no transaction was sent").

To produce it (docs/PROGRESS.md "To unblock", apps/service/scripts/flow-demo.ts): fund the deployer from faucets, `pnpm dev:fund 12`, fund seller bonds and gas, `preflight --budget 5` with 0 FAIL, start the service, then `pnpm --filter @overflow/service flow:demo -- --beat swap`. The beat expects REFUNDED (mismatch) proven onchain and `GET /api/reconciliation` with no open exception. Paste the escrow-funding and refund tx links here.

## Judge's guide: Settings and live controls

The SPEC asks for Settings controls a judge can change live: seller behavior (honest, swap, ghost), price, agent caps, a new payee, and a license flag.

**The Settings page is not built.** `/settings` (apps/web/src/app/settings/page.tsx) renders the placeholder "Settings is not built yet". None of the five controls exists in the web app.

| Control (SPEC) | In the web UI | What exists today instead |
|---|---|---|
| Seller behavior: honest / swap / ghost | Not built | SIMULATED seller API: `GET` / `PUT /sellers/:id/behavior` with body `{"behavior":"honest"\|"swap"\|"ghost"}` on the SIMULATED seller server (`SELLER_URL`, `http://localhost:4100` in docs/PROGRESS.md); apps/service/src/sellers/recourse/routes.ts. `flow:demo --beat honest\|ghost\|swap\|all` switches both SIMULATED sellers and switches them back to honest afterwards. `pnpm demo:reset --behavior honest\|swap\|ghost` (apps/service/scripts/demo-reset.ts) sets both SIMULATED sellers through the same API while the service runs. |
| Price | Not built | Prices are `priceAtomic` in data/catalog.json; changing one is a data edit, not a live control |
| Agent caps | Not built | Contract `raiseCap` (owner only); no UI or recorded tx |
| A new payee | Not built | DEV ONLY `pnpm --filter @overflow/scripts allow-payee <address…>` signs `setAllow` with the owner key (SIMULATES the controller) |
| License flag | Not built | `license` per listing in data/catalog.json (`company-use`, `single-user`); a data edit, not a live control |

Web pages that exist today: Overview (`/`), Missions (`/missions`, `/missions/[id]`), Purchases (`/purchases`, `/purchases/[id]`), Ledger (`/ledger`). Placeholders: Agents, Escrow, Activity (Blocked lane), Settings.

## TODO before submission

- [ ] Fund deployer, treasury, relayer and SIMULATED seller keys; run honest, ghost and swap beats live; paste escrow and refund tx links into "The moment".
- [ ] Rerun `pnpm proof --live` after funding and copy the new results.
- [ ] Harnesses for planted-error cases 8-20.
- [ ] Controller approval through Coinbase Wallet / Wallet MCP, with one real tx link.
- [ ] Build the Settings controls (or tell judges to use the seller API above).
- [ ] Record the scripted replay fallback (no recording exists).
