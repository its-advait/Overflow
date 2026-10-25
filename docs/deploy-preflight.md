# Base Sepolia deployment preflight (read-only review, 2026-10-24)

Scope: `OverflowTreasury`, `OverflowEscrowFactory` and the `OverflowEscrow` implementation it deploys, on Base Sepolia (chain 84532), from branch `person1` at commit `aef089f` plus the test fix committed with this document. Nothing was deployed, broadcast, funded or signed while producing this file; no password file, keystore or private key was read. Environment values were checked by variable name and format only.

**Verdict: deployable once the deployer has more gas ETH (see Blockers).** Everything else in the deploy path is green: build, 194 forge tests, invariants, the fork suite against live USDC, the exporter, and a dry run that simulated all four transactions.

## 1. Chain and toolchain

| Item | Value |
|---|---|
| Chain | Base Sepolia, id 84532 (RPC reports 84532; latest block 49923946 at 2026-10-25T05:39:55Z) |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, `name()` "USDC", `version()` "2", 6 decimals |
| USDC `DOMAIN_SEPARATOR()` | `0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818` (matches CLAUDE.md) |
| Gas price now | 0.006 gwei (base fee 0.005 gwei) |
| Foundry | forge 1.8.6; solc 0.8.28+commit.7893614a; evm cancun; optimizer on, 200 runs |
| Libraries | OpenZeppelin 5.7.0, forge-std 1.9.7 |
| Node / pnpm | v26.7.0 / 12.15.0 (`.nvmrc` says 20; everything ran on 26) |

## 2. Public addresses

| Role | Address | Live state (read 2026-10-24) |
|---|---|---|
| Deployer = treasury owner | `0xB6F4162192F753C9998B63893CBb48FA046906C3` | nonce 2; **0.0000873 ETH** (87329571995315 wei); 0 USDC |
| Relayer (facilitator gas key) | `0xa0943Eb0ccf97DF2B3B3FF4E2259e3B2785b46A1` | **0 ETH**; **1.000000 USDC** (policy says the relayer never holds USDC) |
| Agent root key | `0x390CF9aA0230728dB7E185782F2288E41892Ea89` | 0 ETH, 0 USDC (signs only; the relayer pays gas) |
| Obsolete treasury (not reused) | `0xd3A74fA991CA0B5627d30EF27dC699C134848291` | 17,497 bytes of code, owner = deployer, 0 USDC; `reservationWindow()` and `escrowFactory()` revert (pre-P1.6 ABI) |

Expected new contracts, if the deployer's next transaction is the deploy (nonce 2):

| Contract | Predicted address | How |
|---|---|---|
| OverflowTreasury | `0x7479939c9397FF36C35c4C8F7425B254167De5A6` | `cast compute-address <deployer> --nonce 2`; the dry run logged the same |
| OverflowEscrowFactory | `0xddc66246C333cDC8B918ced02E4d84aCb6B2E8b0` | deployer nonce 3 |
| OverflowEscrow implementation | `0x30c9F9c4d3f50df4d13f6bfB05429d3302Dc85c6` | created by the factory constructor (factory nonce 1) |

No code exists at the predicted treasury address today. Any other transaction from the deployer before the deploy shifts all three.

## 3. Configuration (names and formats only)

`.env` is git-ignored (`.gitignore` lines 5-7) and untracked. Variables present with a value: `AGENT_ROOT_KEY` (address form), `ANTHROPIC_API_KEY`, `BASESCAN_API_KEY`, `BASE_SEPOLIA_RPC_URL` (https, known provider), `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CHAIN_ID=84532`, `DEPLOYER_PRIVATE_KEY` (address form, equals `OWNER_ADDRESS`), `OWNER_ADDRESS=0xB6F4162192F753C9998B63893CBb48FA046906C3`, `RELAYER_PRIVATE_KEY` (address form), `TOKEN_ADDRESS` (= USDC). Present but empty: `DATABASE_URL`, `DEMO_MODE`, `SELLER_KEYS`, `SELLER_URL`, `SOURCE_SIGNER_KEY`. Absent: `DEPLOYER_ADDRESS`, `DEPLOYER_ACCOUNT` (defaults to `overflow-deployer`), `DEPLOYER_PASSWORD_FILE`, `DEMO_PAYEE_ADDRESS`, `ROOT_CAP`, `ROOT_MAX_PER_CALL`, `ROOT_EXPIRY`, `RELAYER_ACCOUNT`, `RELAYER_PASSWORD_FILE`, `AGENT_ROOT_ACCOUNT`, `AGENT_ROOT_PASSWORD_FILE`, `DEMO_TOKEN`, `CLAUDE_MODEL`, `OVERFLOW_DEPLOYMENTS_PATH`.

Foundry keystores present by name: `overflow-deployer`, `overflow-relayer`, `overflow-agent-root`. None was opened.

Values the deploy will use (`contracts/script/Deploy.s.sol`):

| Parameter | Value | Source |
|---|---|---|
| `token` | USDC above | `TOKEN_ADDRESS` |
| `owner` | deployer | `OWNER_ADDRESS` (so `setEscrowFactory` and `createRoot` run in the same script) |
| root key | `0x390CF9aA0230728dB7E185782F2288E41892Ea89` | `AGENT_ROOT_KEY` (deploy.sh turns the address form into `AGENT_ROOT_ADDRESS`) |
| `ROOT_CAP` | 50,000,000 atomic = 50 USDC | default |
| `ROOT_MAX_PER_CALL` | 15,000,000 atomic = 15 USDC | default |
| `ROOT_EXPIRY` | block time + 7 days (dry run: 1793511464 = 2026-11-01T05:37:44Z) | default; set `ROOT_EXPIRY` if the demo is later |
| `floor` | 0 | contract default (`setFloor` later if wanted) |
| `reservationWindow` | 600 s | contract default |
| demo payee allowlist | skipped | `DEMO_PAYEE_ADDRESS` unset |

## 4. Anticipated transactions (dry run, `DRY_RUN=1 pnpm contracts:deploy` with `--sender` = deployer)

| # | Transaction | Gas limit | Notes |
|---|---|---|---|
| 1 | CREATE `OverflowTreasury(token, owner)` | 3,636,547 | runtime 12,594 bytes |
| 2 | CREATE `OverflowEscrowFactory()` | 3,371,670 | constructor also creates the `OverflowEscrow` implementation (nested create, 8,917 bytes) |
| 3 | `treasury.setEscrowFactory(factory)` | 66,050 | owner-only |
| 4 | `treasury.createRoot(root key, 50e6, 15e6, expiry)` | 245,082 | root node id 1 |
| | total | 7,319,349 | forge estimate at 0.011 gwei max fee: **8.0512839e-05 ETH** |

A fifth transaction, `setAllow(DEMO_PAYEE_ADDRESS, true)`, runs only if that variable is set. All contract sizes are far below the 24,576-byte limit (factory 2,562 runtime bytes).

## 5. Funding requirements

| Account | Needs | Has | Action |
|---|---|---|---|
| Deployer | gas for 7.32M gas: 0.00008 ETH at today's fees; keep a margin of at least 2x, ideally 0.002 ETH or more, for fee spikes and the `--verify` retries | 0.0000873 ETH (1.08x the estimate) | **top up from the Base Sepolia faucet before deploying** |
| New treasury | test USDC for the demo budget (root cap 50 USDC; at least the 12 USDC fused purchase + 4 USDC stale set + bonds) | 0 (does not exist yet) | after deploy: faucet USDC to `0x7479…e5A6`, or transfer from any funded key |
| Relayer | gas ETH only (every facilitator relay, escrow action, sweep) | 0 ETH, 1 USDC | fund gas ETH; move the 1 USDC off (to the treasury after deploy) so the key holds no USDC |
| Agent root key | nothing (signs EIP-3009 authorizations; never pays gas) | 0 / 0 | none |
| Recourse seller keys (Phase 3) | gas ETH each, plus bond USDC per open order (20% of price by default: 2.4 USDC for the 12 USDC listing, 0.8 USDC for the 4 USDC set) | `SELLER_KEYS` empty | generate two keys, fund, set `SELLER_KEYS` |

## 6. Source review (what the deploy ships)

`contracts/src/OverflowTreasury.sol`
- `settle()` (line 97) keeps the normative order: 1 digest, 2 signer via `ECDSA.recoverCalldata`, 3-6 `_authorize` (allowlist or escrow checks, node chain, caps, balance floor counting live reservations, line 266), 7 transient approval around `transferWithAuthorization`, 8 `Paid`.
- `_authorize` refuses flagged payees for direct (`PayeeFlagged`, line 236) and escrow payees (`provenCheats`, line 245), requires `value == escrow.amount()` (`EscrowAmountMismatch`, 247) and rejects closed escrows (`EscrowClosed`, 249).
- `reserve()` (131) bounds `validBefore` by `reservationWindow`, records `toIsEscrow` (147); `release()` (158); `releaseClosed()` (171) only for escrow reservations whose escrow is closed.
- `isValidSignature()` (200) stays `view`: `msg.sender == TOKEN`, transient flag, live reservation, and the T18 rule that a reservation to a closed escrow is invalid (211), so USDC reverts "FiatTokenV2: invalid signature".
- Owner surface: `createRoot` (272), `setAllow` (400), `setFloor` (406), `setEscrowFactory` (410), `setReservationWindow` (417). No upgrade path, no pause of the owner itself.

`contracts/src/OverflowEscrow.sol` (clone implementation, `FACTORY` immutable, initialized in the constructor so only clones initialize, line 38-40)
- `markFunded` (54) needs `amount + bond` on the escrow; `revealKey` (63) before `revealDeadline`; `accept` (75) with the buyer node's EIP-712 signature; `finalizePayout` (84) after the challenge window; `claimTimeoutRefund` (90).
- `complainMismatch` (102) and `complainPromise` (128) close first, then `_proveCheat` (158): `recordCheat` on the factory and sweep price + bond to the buyer. `sweep()` (179): terminal states only, `NothingToSweep` on zero balance.
- Record layout the contract reads (`RecourseCrypto.recordTimestamp`, bytes [0,8) of the payload) now matches the TypeScript records and `data/` (commit 186e23b).

`contracts/src/OverflowEscrowFactory.sol`: `create` (22) is deterministic (`Clones.cloneDeterministic`, salt from `orderId` and `termsHash`), `predict` (41), `termsHashOf` (46), `recordCheat` (65) callable only by an escrow the factory created.

`forge build` lint warnings (informational, unchanged since T18): `floor` set without an event (Treasury 406), `_t` set without an event (Escrow 49), revert inside a loop (RecourseCrypto 54), `p` read before init (MerkleLib 44, false positive: `uint256 p;` is zero), no zero check on the escrow constructor's factory (38, set by the factory itself), `block.timestamp` comparisons (66).

## 7. Deployment pipeline review

- `scripts/deploy.sh`: sources `.env`, derives `AGENT_ROOT_ADDRESS` from the address-form `AGENT_ROOT_KEY`, signs with `--account overflow-deployer`; with no `DEPLOYER_PASSWORD_FILE` it **prompts for the keystore password on the terminal** (line 41-44) and refuses in a non-interactive shell. Live mode adds `--broadcast --verify --verifier etherscan` (needs `BASESCAN_API_KEY`, present) and then runs the exporter. It never reads a private key.
- `scripts/export-deployment.ts` + `scripts/lib/broadcast.ts` (commit aef089f): the escrow implementation is read from the factory transaction's nested creates by init code; re-exporting the current treasury-only broadcast is byte-identical. The exporter rewrites `packages/schemas/deployments/base-sepolia.json` wholesale (expected: the old treasury is retired), regenerates `packages/schemas/src/deployments.ts` and the three ABIs.
- ABI exports in `packages/schemas/src/abi/*.ts` equal `contracts/out` today (75 / 17 / 56 entries).
- `contracts/broadcast/`, `contracts/out/`, `contracts/cache/` are git-ignored; the dry run left the tree clean.
- Service boot (`apps/service/src/chain/boot.ts`): verifies chain id, USDC domain, code at the treasury, and `treasury.escrowFactory()` only when the deployments file names a factory. Until the export runs, the service would boot against the old-ABI treasury without complaint. The export closes this gap.

## 8. Checks run (real output, 2026-10-24)

| Check | Result |
|---|---|
| `git status` | clean; `person1` ahead of `origin/person1` by 15 commits, not pushed |
| `forge build --sizes` | ok; Treasury 12,594 / Factory 2,562 / Escrow 8,917 runtime bytes |
| `forge test` | 19 suites, 194 passed, 0 failed, 1 skipped (fork test outside fork mode) |
| `pnpm contracts:invariant` | 2 suites, 4 passed |
| `pnpm contracts:fork` (live USDC, read-only) | 7 passed: domain, settle moves balances, direct bypass reverts, gate closed outside settle, replay without double charge, reservation lets a third party settle, closed escrow rejects a reserved authorization |
| `pnpm -r typecheck` / `pnpm lint` | exit 0 / exit 0 |
| `pnpm test` (vitest, all projects) | 56 files passed, 1 skipped (live-key oracle test); 518 tests passed, 1 skipped |
| `DRY_RUN=1 pnpm contracts:deploy` | "Script ran successfully"; 4 transactions; estimated 7,319,349 gas, 8.0512839e-05 ETH |
| `cast` reads | chain 84532; USDC name/version/decimals/domain separator as expected; old treasury reverts on `reservationWindow()` |

## 9. Blockers and review items

Must fix before `pnpm contracts:deploy`:
1. **Deployer gas.** 0.0000873 ETH covers the estimate 1.08 times. A fee spike or a verification retry fails the run mid-way. Fund to at least 0.002 ETH.
2. **Password entry.** Either run the deploy in an interactive terminal (forge prompts for the `overflow-deployer` keystore password) or create a chmod-600 file and set `DEPLOYER_PASSWORD_FILE`. Do not paste the password into `.env`.

Decide before deploying (defaults are sane for the demo):
3. `ROOT_EXPIRY`: default is deploy time + 7 days (about 2026-11-01). If the demo runs after that, set it; otherwise the root node expires and every agent payment reverts.
4. `DEMO_PAYEE_ADDRESS`: unset means no payee is allowlisted at deploy. Direct-API seller payees (`PAYEE_SEARCH_ADDRESS`, `PAYEE_SCRAPE_ADDRESS`) and any other direct payee need `setAllow` from the owner afterwards; escrow payees need no allowlisting.
5. Owner = deployer (not a Coinbase Wallet). Fine for the hackathon; the controller UI then signs with the deployer keystore.

Not blocking the deploy, blocking the service afterwards:
6. `RELAYER_ACCOUNT=overflow-relayer` + `RELAYER_PASSWORD_FILE` (chmod 600) are required for `pnpm dev`; the relayer has 0 ETH and should hand its 1 USDC to the treasury.
7. `SELLER_KEYS` (two 64-hex keys, funded with gas ETH and bond USDC) for the Recourse sellers; `SOURCE_SIGNER_KEY` may stay empty (the datasets use the labeled SIMULATED signer `0x5a0C6b05F691791F272F84Dcff00fdCda52433Bd`).
8. `DEMO_MODE`, `SELLER_URL`, `DATABASE_URL` are empty: defaults are off, `http://localhost:4100`, PGlite.

## 10. Rollback and recovery

- The contracts are immutable and unproxied. "Rollback" is: stop using an address. The old treasury stays on chain, unused, with 0 USDC. If the new deploy is wrong, redeploy (new addresses) and re-export; nothing on chain needs undoing. Move any USDC out of a retired treasury with the owner's `settle` path only (there is no owner withdraw), so fund the treasury only after `pnpm status` shows the expected wiring.
- Partial failure (for example transaction 3 or 4 reverts or the RPC drops): the broadcast file `contracts/broadcast/Deploy.s.sol/84532/run-latest.json` records what landed. Resume the remaining transactions with the same nonces: `(cd contracts && forge script script/Deploy.s.sol:Deploy --rpc-url $BASE_SEPOLIA_RPC_URL --chain 84532 --account overflow-deployer --resume --broadcast)`. If the treasury landed but `setEscrowFactory` did not, the owner can send it directly: `cast send <treasury> "setEscrowFactory(address)" <factory> --account overflow-deployer --rpc-url $BASE_SEPOLIA_RPC_URL`.
- Verification failed but contracts deployed: retry per contract with `forge verify-contract <addr> <path:Name> --chain 84532 --etherscan-api-key $BASESCAN_API_KEY --watch`, constructor args `$(cast abi-encode "constructor(address,address)" $TOKEN_ADDRESS $OWNER_ADDRESS)` for the treasury, none for the factory, `$(cast abi-encode "constructor(address)" <factory>)` for the escrow implementation.
- Export missed something: `pnpm contracts:export` is idempotent over `run-latest.json`; the escrow implementation can be confirmed with `cast call <factory> "implementation()(address)" --rpc-url $BASE_SEPOLIA_RPC_URL`.
- Service pointing at the wrong deployment: `OVERFLOW_DEPLOYMENTS_PATH` selects any deployments file (the previous one is in git history).

## 11. Deployment commands (for the operator; not run by this review)

```bash
# 0. fund the deployer (faucet), confirm:
cast balance 0xB6F4162192F753C9998B63893CBb48FA046906C3 --rpc-url $BASE_SEPOLIA_RPC_URL --ether
# optional: export ROOT_EXPIRY=<unix seconds after the demo>; export DEMO_PAYEE_ADDRESS=0x...
# 1. simulate once more right before (same predicted addresses iff nonce is still 2)
DEPLOYER_ADDRESS=0xB6F4162192F753C9998B63893CBb48FA046906C3 DRY_RUN=1 pnpm contracts:deploy
# 2. deploy + verify + export (interactive terminal: forge asks for the overflow-deployer password)
pnpm contracts:deploy
# 3. check wiring, then fund the treasury with test USDC
pnpm status
# 4. fork suite against the live deployment, then run the service
pnpm contracts:fork
pnpm dev     # needs RELAYER_ACCOUNT + RELAYER_PASSWORD_FILE and relayer gas ETH
```
