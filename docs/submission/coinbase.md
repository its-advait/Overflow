# Overflow: Coinbase "Best Use of x402, Payment Agents" submission

Repo: https://github.com/its-advait/Overflow · Spec: [docs/SPEC.md](../SPEC.md) · Progress log: [docs/PROGRESS.md](../PROGRESS.md)

**Status as of 2026-10-25, read this first.** Contracts are deployed on Base Sepolia (links below) and the contract and unit test suites pass. **No live mission has run on Base Sepolia**: the treasury holds 0 USDC and the relayer holds 0 ETH (preflight in [docs/PROGRESS.md](../PROGRESS.md), "live P6.3 / P6.4 / P6.5 checks"). No scripted replay recording exists. Overflow will be proven with a **live test and a live demo on Base Sepolia, with live transactions**; section 2 lists each live beat with its evidence slot, and every slot is TODO until the funded run. **Settlement through Coinbase's CDP facilitator is unproven** ([docs/coinbase-feedback.md](../coinbase-feedback.md)). Built and tested, not yet run live on Base Sepolia: the `overflow_pay` MCP server for any agent and controller approvals through Coinbase Wallet MCP. Run live: the CDP server-account sign check (nothing broadcast).

## 1. Summary

**Who it's for.** A business that wants a team of AI agents to buy digital resources (datasets, reports) with company money, without approving every payment or giving each agent an unrestricted wallet.

**What it does.** Overflow gives a team of agents one USDC budget on Base Sepolia. The agents find and buy resources over x402 and pay sellers through a per-order escrow that releases only on verifiable delivery. Every payment passes onchain policy checks before any USDC moves. Agents propose and sign; only the contracts (`OverflowTreasury`, `OverflowEscrowFactory`, `OverflowEscrow`) move money. The system keeps three events separate in the contracts, the ledger and the UI: authorization, escrow funding and final settlement.

**Agent platform.** Claude through the Anthropic SDK (`@anthropic-ai/sdk` in `apps/service/package.json`). The model name comes from `CLAUDE_MODEL`. Call sites: `apps/service/src/orchestration/mission-runner.ts`, `agent-loop.ts`, `sample-judgment.ts`, and the Oracle port. Structured answers use `messages.parse` with Zod. The mission runner drives three agent roles: research, finance and verification. Any other agent that speaks MCP (Claude Code, Claude Desktop) can pay through the same treasury with the `overflow_pay` tool (`packages/overflow-mcp`).

**Coinbase and x402 tools actually used in code**

| Tool | Where | What it does here |
|---|---|---|
| x402 protocol v2 (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`, `exact` scheme on `eip155:84532`) | `packages/payment-client/src/x402.ts`, `header.ts`, `quote.ts`; seller paywall `apps/service/src/sellers/paywall.ts` | Our own client and paywall. The client checks the quote against the purchase order, then the agent's node key signs EIP-3009 with `from` = treasury. |
| `@x402/hono`, `@x402/core`, `@x402/evm` 2.28.0 | `apps/service/src/sellers/spike/server.ts` (the facilitator spike route) | Official seller middleware on one throwaway paid route, used to test the Coinbase facilitator |
| `@coinbase/x402` 2.1.0 with a CDP API key (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`) | `apps/service/src/sellers/spike/server.ts`, `scripts/coinbase-spike.ts` (`pnpm spike:coinbase`) | Authenticated calls to the CDP x402 facilitator `https://api.cdp.coinbase.com/platform/v2/x402`. Every call was a verify-stage rejection; no transaction was broadcast. |
| `CoinbaseFacilitatorAdapter` (our code, targets Coinbase's facilitator) | `packages/payment-client/src/adapters/coinbase.ts`, tests in `adapters.test.ts` | Calls `treasury.reserve()`, then hands the standard x402 payload to the seller's facilitator. Calls `/release` after `validBefore`. **BLOCKED and labeled.** Passing unit tests do not prove live settlement through Coinbase. |
| USDC on Base Sepolia (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) | everywhere | Payment token. `transferWithAuthorization` with a bytes signature, so the token checks the treasury through ERC-1271 |
| Coinbase Wallet MCP (`send_calls`, `get_request_status`) for controller approvals | `.claude/skills/overflow-controller/SKILL.md`, [docs/controller.md](../controller.md), `apps/service/src/api/routes/controller-requests.ts`, `apps/service/src/exceptions/`, `apps/web/src/app/controller/page.tsx` | The service encodes each owner call (`setAllow`, `raiseCap`, `pause`, …) as a `ControllerRequest`. The controller, a Claude Code session with Wallet MCP (`claude mcp add --transport http --scope user base-mcp https://wallet-mcp.coinbase.com`) running the `overflow-controller` skill, sends it with `send_calls`, records `{requestId, approvalUrl}` (`POST /api/controller-requests/:id/submission`), and the human approves in Coinbase Wallet. The service never holds the owner key; only the indexed treasury event marks a request done. Tested against a SIMULATED fixture; **no live Wallet MCP call has been made yet** (docs/coinbase-feedback.md, "Wallet MCP controller"). |
| `@coinbase/cdp-sdk` 1.60.0, CDP EVM server accounts as node keys (optional, `NODE_SIGNER=cdp`) | `packages/payment-client/src/signers/` (`cdp.ts`, `resolve.ts`, `signature.ts`), `packages/payment-client/scripts/cdp-sign-check.ts`, `packages/overflow-mcp/src/config.ts` | The agent's node key lives in Coinbase's TEE. Signatures are normalized to `v` 27/28, high `s` is rejected, and each must recover to the account before use. **Live sign check passed** on 2026-10-25: account `overflow-node-root` `0x646F2bb89286aD517E0cc5420589a65dDe30A415` signed USDC `TransferWithAuthorization` and Overflow delegation payloads as raw 65-byte ECDSA signatures; nothing was broadcast. A live `settle()` signed by it waits for the key's registration on the current treasury (docs/coinbase-feedback.md, "CDP server accounts as agent keys"). |
| `overflow_pay` MCP server (`@modelcontextprotocol/server` 2.4.0) | `packages/overflow-mcp` | Lets any MCP agent pay x402 APIs under an Overflow node's policy: `overflow_budget`, `overflow_quote` (facilitator `POST /verify` simulation, nothing broadcast), `overflow_pay` (one EIP-3009 authorization `from` = treasury, settled only by `treasury.settle()`). |

Not used, although the spec mentions them: Bazaar discovery and the Coinbase MCP.

## 2. Working example

- **Video:** TODO until uploaded.
- **Repo:** https://github.com/its-advait/Overflow
- **`overflow_pay` MCP tool:** `packages/overflow-mcp` ([README](../../packages/overflow-mcp/README.md)). Install for Claude Code, after `pnpm install` and a filled `.env` (`SERVICE_URL`, `BASE_SEPOLIA_RPC_URL`, and a node key: `NODE_PRIVATE_KEY`, or `NODE_ACCOUNT` + `NODE_PASSWORD_FILE`, or `NODE_SIGNER=cdp` with `CDP_ACCOUNT_NAME`):

  ```sh
  pnpm --filter @overflow/overflow-mcp build    # -> packages/overflow-mcp/dist/server.js
  claude mcp add --transport stdio overflow -- node "$(pwd)/packages/overflow-mcp/dist/server.js"
  ```

  `/mcp` then lists `overflow` with `overflow_budget`, `overflow_quote` and `overflow_pay(url, maxAmount)` (atomic USDC as a decimal string; floats are rejected). Claude Desktop takes the same script with absolute paths in `claude_desktop_config.json` and no secrets. Prerequisites: a running Overflow service, a node key the treasury knows, the seller's payee allowlisted by the controller, and USDC in the treasury. Walkthrough: `/api/search` pays; `/premium-intel` is refused with `PayeeNotAllowed(0)` before anything is signed. Live run on Base Sepolia: TODO (needs the funded treasury; docs/PROGRESS.md, "packages/overflow-mcp").

**Setup (from [README.md](../../README.md))**

```sh
git clone --recurse-submodules https://github.com/its-advait/Overflow   # contracts/lib are submodules
cd Overflow
pnpm install
cp .env.example .env              # fill in values; see the variable names below
pnpm typecheck && pnpm build && pnpm test
pnpm contracts:build && pnpm contracts:test
pnpm contracts:fork               # fork suite against live Base Sepolia USDC (needs BASE_SEPOLIA_RPC_URL; read-only)
```

Key `.env` variables (names only): `BASE_SEPOLIA_RPC_URL`, `OVERFLOW_DEPLOYMENTS_PATH`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `RELAYER_ACCOUNT` + `RELAYER_PASSWORD_FILE` (or `RELAYER_PRIVATE_KEY`), `AGENT_ROOT_KEY`, `AGENT_KEYS`, `SELLER_KEYS` (SIMULATED sellers), `ATTACKER_ADDRESS` (SIMULATED), `SELLER_URL`, `DEMO_MODE`, `DEMO_TOKEN`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `DATABASE_URL` or `PGLITE_DATA_DIR`.

**Run the demo**

```sh
pnpm demo:preflight      # green/red: chain + funding (preflight.ts), service, sellers, SSE, model API
pnpm demo:reset          # fresh PGlite DB (service stopped) or set SIMULATED seller behaviors (service running)
pnpm dev                 # web UI + service; service alone: pnpm --filter @overflow/service dev (API 4000, SIMULATED sellers 4100)
pnpm --filter @overflow/service flow:demo --beat all    # honest -> SETTLED, ghost -> timeout refund, swap -> refund by proof
pnpm spike:coinbase      # Coinbase facilitator spike; rewrites docs/coinbase-feedback.md
pnpm --filter @overflow/payment-client cdp:sign-check -- --name overflow-node-root --json   # CDP-held node key: signs, verifies, broadcasts nothing
```

Before `flow:demo` can run live, the treasury needs USDC (`pnpm dev:fund <amount>`, DEV ONLY), the relayer and seller keys need gas (`pnpm --filter @overflow/scripts dev-fund-gas`), and the seller keys need bond USDC (`pnpm dev:fund <amount> --to <seller>`). The full procedure is in the last "live run" entry of [docs/PROGRESS.md](../PROGRESS.md). **This flow has not run on Base Sepolia yet** (TODO: paste Basescan links after the funded run).

**Live test and live demo beats (Base Sepolia)**

No live run has happened yet, so every evidence slot below is empty. Nothing in this table is a result.

| Live beat | Expected onchain outcome | Evidence |
|---|---|---|
| Honest seller paid | Escrow funded, key revealed, buyer accepts, `PaidOut` | Live tx: TODO (Basescan link after the live run) |
| Ghost seller (SIMULATED) | No key reveal; timeout refund to the treasury | Live tx: TODO (Basescan link after the live run) |
| Swap seller (SIMULATED) | Mismatch proof; refund plus bond to the treasury; seller flagged | Live tx: TODO (Basescan link after the live run) |
| Flagged seller opens a new order | Rejected with `PayeeFlagged` | Live tx: TODO (Basescan link after the live run) |
| Prompt-injected agent pays the attacker (SIMULATED) | `settle()` reverts `PayeeNotAllowed` | Live tx: TODO (Basescan link after the live run) |
| Sub-agent over its parent's cap | `settle()` reverts `OverBudget` | Live tx: TODO (Basescan link after the live run) |
| Paused orchestrator, child pays | `settle()` reverts `Paused` | Live tx: TODO (Basescan link after the live run) |
| Same signature sent straight to USDC | USDC reverts `FiatTokenV2: invalid signature` | Live tx: TODO (Basescan link after the live run) |
| Controller actions (agent caps and a new payee from the Settings control panel; pause) | Owner-only treasury txs the controller approves in Coinbase Wallet through Wallet MCP; `/controller` shows DONE only on the indexed event | Live tx: TODO (Basescan link after the live run) |
| An outside agent uses `overflow_pay` | `/api/search` settles through `treasury.settle()`; `/premium-intel` refused with `PayeeNotAllowed(0)` | Live tx: TODO (Basescan link after the live run) |

**Deployed contracts (Base Sepolia, chain 84532; [packages/schemas/deployments/base-sepolia.json](../../packages/schemas/deployments/base-sepolia.json))**

| Contract | Address | Deploy tx |
|---|---|---|
| OverflowTreasury | [0x03805bde8bd8266ad525a9eb13a0eda7facadca2](https://sepolia.basescan.org/address/0x03805bde8bd8266ad525a9eb13a0eda7facadca2) | https://sepolia.basescan.org/tx/0xbb9fd87f128ef5783b4765d4741001287acc4d495ee996fb9e8979db6c5b301c |
| OverflowEscrowFactory | [0x933bc257a24d94786d0021745470d343d3391808](https://sepolia.basescan.org/address/0x933bc257a24d94786d0021745470d343d3391808) | https://sepolia.basescan.org/tx/0x17570db986b411cd99fd0f336627d23f8bb2298750537234d37d1955bb11d20f |
| OverflowEscrow implementation | [0x16fb922f0b3aa2c09d0e5e56640f7b0fd3e14f20](https://sepolia.basescan.org/address/0x16fb922f0b3aa2c09d0e5e56640f7b0fd3e14f20) | same tx as the factory |
| `setEscrowFactory` | | https://sepolia.basescan.org/tx/0x292d0e3cdce7cde3715afee886fcbdeab95fac62668f2a6c7733daba92b5e948 |
| `createRoot` (orchestrator node) | | https://sepolia.basescan.org/tx/0x4aea260876dc3cfa33bdedbebd4791a7550d39f3349229656693a870abf9f7b2 |

No payment, escrow funding or settlement transaction exists on Base Sepolia yet. The three Recourse scenarios did run end to end (real contracts, facilitator path and indexer, SIMULATED sellers) on a **local Anvil fork** of Base Sepolia: honest `Settled`, ghost `Refunded` (timeout), swap `Refunded` (mismatch proof, `provenCheats = 1`). Those transactions stayed local and have no Basescan links (docs/PROGRESS.md, "recourse orders end to end on local Anvil").

## 3. Architecture

Components and diagram: [docs/architecture.md](../architecture.md) (from the spec's Architecture section, [docs/SPEC.md](../SPEC.md#architecture)). In short, Claude agents and the Overflow service propose and sign. The treasury authorizes each payment against the agent tree. USDC asks the treasury (ERC-1271) before it moves anything. Each order gets its own escrow, which pays the seller after a key reveal or refunds the treasury on proof or timeout.

**Controls and evidence**

| Control | What it enforces | Evidence |
|---|---|---|
| Policy tree (`OverflowTreasury.settle()`) | Before any token call, the payment walks from the signing node to the root and checks `UnknownAgent`, `PayeeNotAllowed`, `Paused`, `Expired`, `OverPerCall`, `OverBudget` and `BelowFloor`. Delegation to sub-agents is gasless and signed (`createChild`). | `contracts/test/unit/OverflowTreasury.t.sol`, `contracts/test/adversarial/Adversarial.t.sol`, `contracts/test/invariant/TreasuryInvariant.t.sol`. Live beats (section 2): attacker payee (`PayeeNotAllowed`), sub-agent over its parent's cap (`OverBudget`), paused orchestrator (`Paused`). Live tx: TODO (Basescan link after the live run). |
| ERC-1271 gate (`isValidSignature`) | Returns valid only when `msg.sender == USDC` and a transient flag for that exact digest is set inside a running `settle()`. A prompt-injected agent's signature sent straight to USDC fails. | `contracts/test/usdc/UsdcReal.t.sol` (against Circle's compiled FiatTokenV2_2). `contracts/test/fork/UsdcGate.t.sol` against live Base Sepolia USDC (`test_fork_directBypassReverts`, `test_fork_gateClosedOutsideSettle`, `test_fork_replayRevertsWithoutDoubleCharge`); `pnpm contracts:fork` reported 7 passed ([docs/PROGRESS.md](../PROGRESS.md)). Live beat (section 2): direct-to-USDC bypass, `FiatTokenV2: invalid signature`. Live tx: TODO (Basescan link after the live run). |
| Reservations (`reserve()` / `release()` / `releaseClosed()`) | Lets a third-party facilitator call USDC later, for one digest only. Budgets are charged up front, `reservedTotal` counts toward the floor, the window is capped, and the gate turns INVALID once the reservation's escrow has closed. | `contracts/test/unit/Reservations.t.sol`, `contracts/test/unit/ReservationGate.t.sol`; fork tests `test_fork_reservationLetsThirdPartySettle`, `test_fork_closedEscrow_usdcRejectsReservedAuthorization`. **Not proven through Coinbase's facilitator** (section 4). |
| Per-order escrow (`OverflowEscrowFactory` / `OverflowEscrow`) | The escrow address is the order, so the agent's signed `to` binds it. The seller posts a bond. `accept()` pays out. A timeout, a chunk-mismatch proof or a broken-promise proof refunds the treasury; proven cheaters are flagged (`PayeeFlagged`). | `contracts/test/escrow/` (`OverflowEscrow.t.sol`, `EscrowMismatch.t.sol`, `EscrowPromise.t.sol`, `MerkleLib.t.sol`), `contracts/test/invariant/EscrowInvariant.t.sol`. `pnpm contracts:test`: 20 suites, 196 passed, 0 failed, 1 skipped (fork suite off-fork) ([docs/PROGRESS.md](../PROGRESS.md)). The escrow has not run live yet; the honest, ghost, swap and flagged-seller live beats in section 2 exercise it. Live tx: TODO (Basescan link after the live run). |
| Quote check and single nonce (offchain) | Before signing, the payment client rejects a quote whose `payTo`, amount, asset or network differs from the order. An uncertain payment is reconciled through USDC `authorizationState`, never retried with a new nonce. | `packages/payment-client/src/quote.ts` + `quote.test.ts`; `apps/service/src/payment/overflow-adapter.ts`. `pnpm test`: 87 files, 736 tests passed ([docs/PROGRESS.md](../PROGRESS.md)). |

**SIMULATED and labeled:** the seller catalog and datasets, the Recourse sellers (`sim-seller-a`, `sim-seller-b`, with honest, swap and ghost behaviors), the attacker address and the company books.

**Known limits:** [docs/limitations.md](../limitations.md). In brief:
- No live mission on Base Sepolia yet, because the treasury, relayer and seller keys are unfunded.
- The live test and live demo beats (section 2) have no Basescan links yet; the run is blocked on relayer gas and treasury USDC.
- Coinbase facilitator settlement is unproven, and the `CoinbaseFacilitatorAdapter` stays BLOCKED.
- `overflow_pay` and the Wallet MCP controller flow are built and tested but have not run live; the owner transactions recorded so far were signed by the deployer key through DEV ONLY scripts that SIMULATE the controller.
- The CDP-held node key passed its live sign check but has not signed a broadcast `settle()` yet.
- The public RPC caps `eth_getLogs` at a 200-block range, so the sweep reconciler needs chunking.
- The Recourse order store is in memory.

## 4. Builder feedback

Source: [docs/coinbase-feedback.md](../coinbase-feedback.md), from `pnpm spike:coinbase` on 2026-10-25T04:05:35Z. Setup: the official `@x402/hono` 2.28.0 middleware, `@coinbase/x402` 2.1.0 with our CDP key, and the CDP facilitator `https://api.cdp.coinbase.com/platform/v2/x402`. The payer was the earlier treasury `0xd3A74fA991CA0B5627d30EF27dC699C134848291`, signed by a public throwaway test key. No transaction was broadcast.

**Biggest blocker: a contract (ERC-1271) payer whose signature only USDC can validate.** Verbatim errors, decoded from the 402 `PAYMENT-REQUIRED` header:

| Case | Facilitator | Error |
|---|---|---|
| (a) with reserve (reservation step unavailable) | CDP | `invalid_payload: contract call failed: unable to call contract: execution reverted` |
| (b) without reserve | CDP | `invalid_payload: contract call failed: unable to call contract: execution reverted` |
| (c) expired (`validBefore` in the past) | CDP | `invalid_exact_evm_payload_authorization_valid_before: valid before expired: 1792901015` |
| (a), (b), (c) | public x402.org | `invalid_exact_evm_signature` |

Differential probes against CDP `/verify` showed that a wrong EOA signature fails at the signature stage (`invalid_exact_evm_payload_signature: invalid signature: 0x…`). A valid EOA signature with no balance fails with the same `invalid_payload ... execution reverted` that the treasury gets. So the CDP facilitator passed the treasury's signature stage and then reverted in simulation. The public x402.org facilitator recovers an EOA and stops at the signature stage. That treasury predated `reserve()` and held 0 USDC, so case (a) could not be proven. The spike has not been rerun against the redeployed treasury `0x0380…dca2` (TODO).

**Our workaround.** The demo pays through the Overflow facilitator path: our own relayer submits `treasury.settle()`, and USDC asks the treasury (ERC-1271) inside the same transaction. The `CoinbaseFacilitatorAdapter` stays BLOCKED and labeled. It models the rejection (`PAYMENT_PENDING` with the facilitator's reason, then `/release` after `validBefore`). Once the treasury holds USDC and `reserve()` is live, `pnpm spike:coinbase` with the service running settles case (a) for real.

**The one capability we'd ask Coinbase for** (quoted from [docs/coinbase-feedback.md](../coinbase-feedback.md)):

> Surface the simulated revert reason instead of the opaque `contract call failed: unable to call contract: execution reverted`, and document ERC-1271 payers whose validity is only visible to the token (`msg.sender == USDC`). Today a policy wallet that gates `isValidSignature` on the caller cannot tell "no balance" from "no reservation" from "wrong signer", and cannot know from the docs whether the facilitator will ever reach `transferWithAuthorization` for it.

## TODO before submitting

- [ ] Upload the demo video and replace "TODO until uploaded".
- [ ] Fund the treasury, relayer and seller keys, run the live test and live demo beats on Base Sepolia (including `flow:demo --beat all`), and paste the Basescan tx links into section 2.
- [ ] Confirm `docs/architecture.md` and `docs/limitations.md` exist (both are linked above).
- [ ] Rerun `pnpm spike:coinbase` against the redeployed treasury once it holds USDC, and update section 4 if case (a) settles.
- [ ] Run `overflow_pay` from a fresh Claude Code session against the funded treasury and paste the settle tx link.
- [ ] Run one live Wallet MCP controller approval and record it in docs/coinbase-feedback.md, "Wallet MCP controller".
