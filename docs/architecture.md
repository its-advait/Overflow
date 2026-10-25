# Architecture

Agents and the Overflow service propose and sign; only three contracts move USDC (`OverflowTreasury`, `OverflowEscrowFactory`-created `OverflowEscrow` clones, and USDC itself on their instruction). USDC asks the treasury (ERC-1271) before every transfer that names the treasury as payer. Source: docs/SPEC.md, "Architecture".

Deployed on Base Sepolia (chain 84532), from `packages/schemas/deployments/base-sepolia.json`:

| Contract | Address | Deploy tx |
|---|---|---|
| OverflowTreasury | `0x03805bdE8BD8266Ad525A9eb13A0eDa7fAcaDca2` | [0xbb9fd87f…301c](https://sepolia.basescan.org/tx/0xbb9fd87f128ef5783b4765d4741001287acc4d495ee996fb9e8979db6c5b301c) |
| OverflowEscrowFactory | `0x933Bc257a24D94786D0021745470D343d3391808` | [0x17570db9…1d20f](https://sepolia.basescan.org/tx/0x17570db986b411cd99fd0f336627d23f8bb2298750537234d37d1955bb11d20f) |
| OverflowEscrow implementation | `0x16fb922f0b3aa2c09d0e5e56640f7b0fd3e14f20` | same tx as the factory |
| USDC (Circle) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | not ours |

## Components

```mermaid
flowchart LR
  subgraph Human
    CTRL[Controller<br/>Coinbase smart wallet = owner<br/>Claude Code + overflow-controller skill]
    WMCP[Coinbase Wallet MCP<br/>send_calls, human approves]
  end

  subgraph Agents["Agents"]
    EXT[Any MCP agent<br/>Claude Code, Claude Desktop]
    MCP[overflow-mcp<br/>packages/overflow-mcp<br/>overflow_budget / overflow_quote / overflow_pay]
    CDP[(Optional CDP server account<br/>node key in Coinbase's TEE<br/>NODE_SIGNER=cdp)]
  end

  subgraph Offchain["Overflow service (apps/service, Node)"]
    WEB[Web UI<br/>apps/web, Next.js<br/>Overview, Missions, Purchases, Agents,<br/>Escrow, Ledger, Controller, Settings]
    API[Service API<br/>api/]
    ORCH[Orchestration<br/>mission runner, sub-agents]
    CLAUDE[(Claude via<br/>Anthropic SDK<br/>model = CLAUDE_MODEL)]
    ORACLE[Oracle<br/>packages/oracle]
    FUSION[Fusion<br/>packages/fusion]
    PAY[Payment client + adapters<br/>packages/payment-client, payment/]
    FAC[Facilitator / relayer<br/>facilitator/, gas ETH only]
    IDX[Indexer + ledger + reconciliation<br/>chain/, ledger/, reconciliation/]
    CREQ[Exceptions + ControllerRequests<br/>pending until the indexed event]
    DB[(Postgres or PGlite<br/>packages/database)]
  end

  subgraph Sellers["SIMULATED sellers (apps/service/src/sellers)"]
    SELL[sim-seller-a / sim-seller-b<br/>x402 paywall, order terms, ciphertext]
    ATK[SIMULATED attacker endpoint<br/>never allowlisted]
  end

  subgraph Chain["Base Sepolia"]
    TRE[OverflowTreasury<br/>settle / reserve / release<br/>ERC-1271 gate]
    FAC_C[OverflowEscrowFactory]
    ESC[OverflowEscrow per order<br/>fund, reveal, accept, refund]
    USDC[USDC v2.2]
  end

  WEB --> API
  EXT -->|stdio MCP| MCP
  MCP -->|402 quote, paid GET| SELL
  MCP -->|POST /verify, settle| FAC
  CDP -. signs EIP-712 .-> MCP
  CDP -. signs EIP-712 .-> PAY
  API --> ORCH
  ORCH --> CLAUDE
  ORCH --> ORACLE
  ORACLE --> CLAUDE
  ORCH --> FUSION
  ORCH --> PAY
  PAY -->|402 quote, paid GET| SELL
  PAY -.->|refused before signing| ATK
  SELL -->|signed EIP-3009 payload| FAC
  PAY --> FAC
  FAC -->|settle / reserve| TRE
  SELL -->|create order| FAC_C
  FAC_C -->|CREATE2 clone| ESC
  TRE -->|transferWithAuthorization| USDC
  USDC -->|isValidSignature| TRE
  USDC -->|funds| ESC
  ESC -->|payout| SELL
  ESC -->|refund| TRE
  API --> CREQ
  CREQ -->|pending requests: target, data| CTRL
  CTRL --> WMCP
  WMCP -->|owner actions: setAllow, raiseCap, pause, fund| TRE
  IDX -->|AllowSet, CapRaised, NodePaused by owner marks done| CREQ
  TRE -. events .-> IDX
  ESC -. events .-> IDX
  FAC_C -. events .-> IDX
  USDC -. Transfer logs .-> IDX
  IDX --> DB
  API --> DB
```

Notes:
- Two ways in for an agent: the service's own Claude agents (mission runner, sub-agents) and any agent that speaks MCP through `packages/overflow-mcp` (`overflow_budget`, `overflow_quote`, `overflow_pay`). Both end at the same `OverflowTreasury.settle()` through the facilitator; the MCP server holds no owner key and never retries a payment (packages/overflow-mcp/README.md).
- A node key can live in a Foundry keystore, an env key, or (optionally, `NODE_SIGNER=cdp`) a Coinbase Developer Platform EVM server account (`packages/payment-client/src/signers/`). The CDP account signs the same raw 65-byte ECDSA signatures the treasury checks (docs/coinbase-feedback.md, "CDP server accounts as agent keys").
- Controller approvals: an agent or operator raises an exception; onchain types get a `ControllerRequest` with `{target, data, value}`. The controller (a Claude Code session with Coinbase Wallet MCP and the `.claude/skills/overflow-controller` skill) sends it with `send_calls`, records the submission, and the human approves in Coinbase Wallet. Only the indexed treasury event marks it done (docs/controller.md).
- The facilitator is in-process in the service. A second adapter targets Coinbase's facilitator through `reserve()`; it is BLOCKED (docs/coinbase-feedback.md) and the running service uses the Overflow path.
- The relayer pays gas only; it is never a payer of USDC. (It currently holds 1 USDC that nothing moved; see docs/limitations.md.)
- Sellers, their datasets, the attacker and the company's books (Larkspur Research Partners) are SIMULATED.

## Trust boundaries

From docs/SPEC.md, "Trust boundaries":

| Component | Trusted to | Not trusted to |
|---|---|---|
| Claude agents | Propose purchases and sign within their node | Spend outside policy; they can be prompt-injected |
| Overflow service and facilitator | Relay, index, run the adapters | Hold funds or the owner key |
| OverflowTreasury | Enforce policy on every payment | Judge whether data is good |
| Coinbase facilitator | Submit reserved payments | Bypass policy, since USDC asks the treasury |
| Sellers (SIMULATED) | Deliver what they committed to | Anything else; escrow pays only after a reveal |
| overflow-mcp server (any agent) | Quote, simulate and sign one payment for its node | Hold the owner key, retry a payment, or move USDC except through `treasury.settle()` |
| Coinbase Wallet MCP and the controller session | Submit owner calls for human approval | Mark a request done; only the indexed treasury event does |

## Web pages

| Page | What it shows |
|---|---|
| Overview (`/`) | Money cards, mission progress, latest events with the Blocked lane and decoded revert reasons |
| Missions (`/missions`, `/missions/[id]`) | Compose a mission, its extracted requirements and purchases |
| Purchases (`/purchases`, `/purchases/[id]`) | Oracle comparison, Fusion proposal, authorization preview, payment timeline |
| Agents (`/agents`) | The delegation tree read from the treasury: each node's cap, spend, pause state and budget bar, with request dialogs (raise cap, pause) that become controller requests |
| Escrow (`/escrow`, `/escrow/[id]`) | Order list and detail: state diagram lit from the chain read with the confirmed log for each step, terms table, sample view, evidence panel (mismatch proof, timeout), allowed actions with decoded reasons |
| Ledger (`/ledger`) | Journal entries from chain events, reconciliation, exceptions |
| Controller (`/controller`) | Controller requests: `pending`, `awaiting approval` (Coinbase Wallet link), `DONE (indexed event)` with the Basescan link, `rejected` |
| Settings (`/settings`) | The live control panel (docs/SPEC.md, "A judge's own scenario") |
| Activity (`/activity`) | Still the shell's generic page on main; the event feed is on Overview |
| Controller | Set policy and approve exceptions | Approve every routine payment |

Boundary rules enforced in code:
- A valid agent signature is never enough: `settle()` / `reserve()` run the policy checks, and the treasury's `isValidSignature` answers yes only for the digest it is currently settling or a stored reservation (docs/SPEC.md, "The stateful ERC-1271 gate"). A signature sent straight to USDC is refused (`test_direct_to_token_bypass_reverts`, `test_fork_directBypassReverts`; the live demo replays this bypass on Base Sepolia. Live tx: TODO (Basescan link after the live run)).
- The buyer never trusts the seller's order terms: `orchestration/seller-order-terms.ts` recomputes `termsHash` and `orderId` from the wire fields and checks `factory.predict(...)` equals the returned escrow (docs/PROGRESS.md, "SIMULATED Recourse sellers").
- Owner actions use `msg.sender == owner`; there are no `/admin` routes on the service.

## One purchase, end to end (10 steps)

From docs/SPEC.md, "One purchase, end to end". Steps 1-7 and 9 are implemented in the service (`orchestration/purchase-flow.ts`, `orchestration/delivery-watcher.ts`); steps 8 and 10 are the chain and the indexer (docs/PROGRESS.md, "end-to-end purchase flow"). The flow is exercised in tests against an in-memory fake escrow, and the three Recourse scenarios (honest paid, ghost timed out, swap caught by a Merkle proof) ran end to end against the real contracts, the real facilitator path and the real indexer on a **local Anvil fork** of Base Sepolia (`scripts/anvil-up.sh`, `pnpm --filter @overflow/service anvil:provision`, `RECOURSE_ANVIL_RUN=1`; docs/PROGRESS.md, "recourse orders end to end on local Anvil"). It has **not run live on Base Sepolia** (docs/limitations.md).

1. The mission owner sets a goal and budget; Oracle extracts requirements and ranks listings.
2. Fusion merges compatible requests into one `PurchaseOrder` with allocations.
3. The seller creates the order's escrow through the factory and commits the roots and the key hash.
4. The agent downloads the ciphertext, checks `rootCipher`, and samples chunks; Oracle judges the sample.
5. The agent requests the resource; the seller's 402 names the escrow as `payTo`.
6. The payment client checks the quote against the order, and the paying node signs EIP-3009 with `from` = treasury.
7. The adapter calls `settle()` (Overflow facilitator), or calls `reserve()` and hands the payload to Coinbase's facilitator.
8. USDC asks the treasury via ERC-1271; the treasury says yes only for this checked digest; USDC moves into the escrow.
9. The seller reveals the key and the agent checks the file. `accept()` pays the seller, or a proof or timeout refunds the treasury.
10. The indexer reads events, the ledger books entries, and reconciliation confirms the chain and the books agree.

## Three financial events, kept separate

| Event | What it means | Onchain | Ledger (immediate-expense policy, docs/SPEC.md "Journal entries") | Purchase state |
|---|---|---|---|---|
| 1. Authorization | An agent may commit up to an amount for one specific order | A signed EIP-3009 authorization checked by the treasury's policy; with `reserve()` the budget is charged and a reservation stored, but no USDC moves | Reservation: no entry (memo only) | Signed / reserved; a refusal is `REJECTED` with the decoded error |
| 2. Escrow funding | USDC leaves the treasury and sits in that order's escrow | `settle()` → USDC `transferWithAuthorization` to the escrow; escrow `OrderFunded` once it holds price + bond | Debit escrow deposit, credit USDC treasury | `ESCROW_FUNDED`, set only by the indexer |
| 3. Final settlement | The seller is paid, or the treasury is refunded | `accept()` / `finalizePayout` → `PaidOut`; `claimTimeoutRefund` / `complainMismatch` / `complainPromise` → `Refunded` | Paid: debit data expense by department, credit escrow deposit. Refund: debit USDC treasury, credit escrow deposit; a forfeited bond is other income | `SETTLED` or `REFUNDED`, set only by the indexer |

Rules that keep them apart:
- The delivery watcher never sets `ESCROW_FUNDED`, `SETTLED` or `REFUNDED`; those come only from indexed chain events (docs/PROGRESS.md, "end-to-end purchase flow").
- A refund restores treasury USDC, not the agent's spent allowance (docs/SPEC.md, "Refund semantics"; `test_timeoutRefund_restoresTreasuryUsdc`).
- A payment whose outcome is unknown is never retried with a new nonce; `reconcilePayment` reads USDC `authorizationState` and the `Paid` logs first (docs/PROGRESS.md, "end-to-end purchase flow").
- Reconciliation compares `balanceOf(treasury)` with the ledger's USDC treasury account, each open escrow's balance (minus bond) with its deposit line, and requires exactly one entry per `Paid` / `PaidOut` / `Refunded`; a difference above 0.01 USDC opens an exception for the controller (docs/PROGRESS.md, `ledger/reconciliation.ts`).
