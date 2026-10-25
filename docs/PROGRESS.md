# Progress

## 2026-10-24: scaffold Overflow monorepo

### Built
- pnpm workspace (`apps/*`, `packages/*`), TypeScript strict via `tsconfig.base.json`, Node >= 20 (`.nvmrc` = 20; verified locally on Node 26.7.0 / pnpm 12.15.0).
- `apps/web`: Next.js 16.4.3 App Router (Turbopack), Tailwind v4, shadcn/ui v4 (`base-nova` style, `components.json`, `src/lib/utils.ts`, `Button`), lucide-react. Home page is labeled "SCAFFOLD: no live data" and imports `@overflow/schemas` to prove `transpilePackages` works.
- `apps/service`: Node + TypeScript with `src/{api,orchestration,facilitator,sellers,chain}/` placeholder modules. `tsx watch` for dev, `tsup` bundle for build. Boots a tiny HTTP server that returns a JSON status object. Depends on viem, zod, `@anthropic-ai/sdk` and all six packages.
- `packages/schemas` (zod; `AddressSchema`, `AtomicAmountSchema`, `CHAIN_ID`, `USDC_DECIMALS`, plus a 3-case smoke test), `packages/oracle`, `packages/fusion`, `packages/payment-client` (viem), `packages/recourse-crypto` (viem), `packages/database` (drizzle-orm + postgres + drizzle-kit, placeholder `scaffold` table and `drizzle.config.ts`).
- `contracts/`: Foundry, solc 0.8.28, `evm_version = "cancun"`, optimizer on, forge-std v1.9.7 and OpenZeppelin Contracts v5.7.0 as git submodules (`foundry.lock` committed). `test/Scaffold.t.sol` checks the toolchain and that `tstore`/`tload` compile and run.
- Root scripts: `dev`, `build`, `typecheck`, `lint`, `test` (vitest projects over `packages/*` and `apps/service`), `contracts:build`, `contracts:test`.
- `.env.example` with all 20 keys (only `CHAIN_ID` and `TOKEN_ADDRESS` carry values). `CLAUDE.md`, `README.md`, `docs/SPEC.md` placeholder, `docs/CHANGELOG.md`.
- `reference/leash` cloned (depth 1) and ignored via `reference/` in `.gitignore`.

### Design choices
- Packages export TypeScript source (`"exports": "./src/index.ts"`), no `dist`. tsx, Next (`transpilePackages`) and Vitest consume it directly, so there is no stale-build step and `pnpm typecheck` works on a fresh clone. The service bundles workspace packages with `tsup` (`noExternal: [/^@overflow\//]`).
- pnpm 12 blocks dependency build scripts by default; `pnpm-workspace.yaml` sets `allowBuilds` for `esbuild` and `unrs-resolver` only. Without this, `pnpm add` inside shadcn/tsx/tsup setups fails with `ERR_PNPM_IGNORED_BUILDS`.
- Web `typecheck` runs `next typegen && tsc --noEmit` because Next 16 generates global types (`LayoutProps`) that plain `tsc` cannot see before a build.

### Stubbed or simulated
- Every package `index.ts` exports a `*_STATUS = "scaffold: not implemented"` constant and nothing else of substance.
- `apps/service/src/sellers` is marked SIMULATED in code; it has no behaviour yet.
- The web home page renders static text and a disabled button; it reflects no chain or API state.
- `contracts/src` is empty (only `.gitkeep`). No Treasury/Escrow code yet.
- `packages/database` has a placeholder table only; no migrations, no client factory.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm typecheck` | exit 0, 8 workspaces Done |
| `pnpm build` | exit 0 (`tsup` build success; `next build` compiled, 2 static routes) |
| `pnpm test` | exit 0, 1 file / 3 tests passed |
| `pnpm lint` | exit 0 (web only) |
| `forge build` (contracts) | exit 0, "Compiling 21 files with Solc 0.8.28 ... Compiler run successful!" |
| `forge test` (contracts) | 2 passed, 0 failed |
| `node apps/service/dist/index.js` | served JSON status on the SERVICE_URL port |
| `git check-ignore reference/leash` | matched `.gitignore:22:reference/` |

### Open issues
- ESLint is configured only for `apps/web`. Packages and the service have no linter yet.
- `pnpm dev` runs web and service in parallel but neither has anything to do yet.
- Teammates must clone with `--recurse-submodules` (or run `git submodule update --init`) for `contracts/lib`.
- `docs/SPEC.md` is still the placeholder line; paste the exported spec before the next prompt.
- `drizzle-kit` reads `DATABASE_URL` from the environment; no `.env` loading is wired yet.

## 2026-10-24: real USDC v2.2 harness

### Built
- `contracts/script/build-usdc-fixture.sh`: clones `circlefin/stablecoin-evm` at pinned commit `fc85788bc7c23cefe3df1a757133048bfddadeaa`, downloads the solc 0.6.12 release binary for the host (`solc-static-linux` on Linux, `solc-macos` on macOS), fetches `@openzeppelin/contracts@3.4.2` with `npm pack`, compiles `FiatTokenV2_2`, `FiatTokenProxy` and `SignatureChecker` with `--optimize --optimize-runs 10000000 --combined-json abi,bin,bin-runtime`, links `SignatureChecker` to `0x00000000000000000000000000000000005157c0`, and writes `contracts/test/fixtures/usdc-v2_2/{FiatTokenV2_2.linked.hex,FiatTokenProxy.hex,SignatureChecker.hex,README.md}`. Fixtures are committed; nobody else needs solc 0.6.12.
- `contracts/foundry.toml`: read-only `fs_permissions` for `./test/fixtures`.
- `contracts/test/usdc/UsdcV22.sol`: `IUSDC` interface and `UsdcV22` library (`deploy`, `deployFull`, `mint`, `transferWithAuthorizationDigest`). Deploys SignatureChecker from its creation code and etches the runtime at the linked address, deploys the implementation, deploys the proxy as `proxyAdmin` (prank), then runs `initialize("USDC","USDC","USD",6,owner...)`, `initializeV2("USDC")`, `initializeV2_1(owner)`, `initializeV2_2([], "USDC")` from the test contract and `configureMinter(owner, max)` as owner.
- `contracts/test/usdc/UsdcReal.t.sol`: 8 tests. name/version/decimals; `DOMAIN_SEPARATOR()` equals `keccak256(EIP712Domain typehash, "USDC", "2", chainid, usdc)`; mint; proxy admin cannot call through the proxy; **ERC-1271 caller proof**: a `CallerGatedWallet` that returns the magic value only when `msg.sender == expectedCaller`. With `expectedCaller = usdc proxy` the `transferWithAuthorization(..., bytes)` call succeeds; with `expectedCaller = implementation` it reverts `FiatTokenV2: invalid signature`; replay reverts `FiatTokenV2: authorization is used or canceled`.

### Deviations from the prompt, and why
- **solc binary on Apple Silicon.** The v0.6.12 release ships only x86_64 binaries and this machine has no Rosetta, so the script falls back to the official `solc@0.6.12` npm build (same compiler, Emscripten build) when the downloaded binary cannot execute. Native is still the primary path on Linux or Rosetta Macs. The fixtures README records which mode produced them.
- **"Wallet records msg.sender."** USDC's `SignatureChecker` reaches the signer with a `staticcall`, so storage writes and logs revert inside `isValidSignature`. The wallet instead gates on an expected caller, and the test includes a negative control, which is the same proof made observable.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `bash contracts/script/build-usdc-fixture.sh` | exit 0, solc `0.6.12+commit.27d51765.Emscripten.clang` (solc-js fallback) |
| Second run into a scratch dir, `cmp` each `.hex` | byte-identical; README identical |
| `grep -c '__\$' FiatTokenV2_2.linked.hex` | 0 (fully linked) |
| Compare with live Base Sepolia USDC implementation `0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5` (`cast code`, metadata stripped) | 23464-byte runtime identical except the two 20-byte SignatureChecker address slots (live: `0xba3b60c21e28c41df4babd90f228e1d368627da6`) |
| Live `name()/version()/DOMAIN_SEPARATOR()` on `0x036C…CF7e` | `USDC`, `2`, `0x71f17a3b…c9818` as in CLAUDE.md |
| `forge test --match-path 'test/usdc/*'` | 8 passed, 0 failed |
| `pnpm contracts:test` (full) | 10 passed (8 USDC + 2 scaffold) |

### Open issues
- The fixtures were produced with solc-js on this machine. A Linux or Rosetta teammate should run the script once to confirm the native binary yields the same SHA-256 (listed in the fixtures README). The live-bytecode comparison above already shows the compiled runtime matches Circle's deployment.
- `UsdcV22` is a test helper only; nothing in `src/` yet. The treasury's ERC-1271 gate tests will build on `deployFull` and `transferWithAuthorizationDigest`.

## 2026-10-24: OverflowTreasury core ported from Leash

### Built
- `contracts/src/IOverflowTreasury.sol`: Leash's `ILeashWallet` renamed. Same `Node`/`ChildParams` structs, 13 errors, 6 events, function list; `AUSD()` is now `TOKEN()`.
- `contracts/src/OverflowTreasury.sol`: `LeashWallet` ported line for line. Changes, and only these: `constructor(address token, address owner)`, immutables `TOKEN`/`owner`, delegation EIP-712 domain `{"Overflow", "1", chainId, this}`, and steps 3 to 6 of `settle()` factored into `internal _authorize(to, value, digest, signer) returns (id)` for P1.5's `reserve()`. `settle()` keeps the normative order (digest over USDC's `DOMAIN_SEPARATOR` with `from = this`; `ECDSA.recoverCalldata`; `UnknownAgent`; global allowlist; walk to root with Paused, Expired, OverPerCall, restricted `nodeAllow`, OverBudget, then charge; `BelowFloor`; `tstore` flag at `keccak256(abi.encode(APPROVAL_SALT, digest))`; bytes-signature `transferWithAuthorization`; `tstore 0`; `Paid`). `nonReentrant` via OpenZeppelin `ReentrancyGuardTransient`. `isValidSignature` is `view`, TLOAD only, `0x1626ba7e` iff `msg.sender == TOKEN` and the flag is set, ignores the signature bytes.
- `APPROVAL_SALT` is `keccak256("overflow.approval.v1")` and the slot encodes `(SALT, digest)` as the spec writes it (Leash used `(digest, SALT)`); no behavioral effect.
- Tests, all on Circle's compiled USDC v2.2 via `UsdcV22`: `contracts/test/unit/TreasuryBase.t.sol` (harness), `contracts/test/unit/OverflowTreasury.t.sol` (51 tests: the 44 ported Leash unit tests plus the new ones below), `contracts/test/adversarial/Adversarial.t.sol` (3 ported auditor tests).
- New tests required by the prompt: blacklisted payee reverts `Blacklistable: account is blacklisted` with no partial charge; gate closed outside `settle()` for USDC, the owner and an attacker, before and after a payment; the same signature straight to USDC reverts `FiatTokenV2: invalid signature`, then settles through the treasury, then cannot be replayed (`FiatTokenV2: authorization is used or canceled`); a restricted parent's child may only list allowed payees (and the grandchild is then blocked for others); owner `pause(2)` blocks the grandchild while the root still pays.
- `docs/contract-invariants.md`: T1 to T14 with enforcing code path and covering test; P1.5+ reservation/escrow invariants listed as pending.
- `contracts/.gas-snapshot` written by `forge snapshot` (63 entries).

### Not ported, on purpose
- `Golden.t.sol` (TypeScript golden vectors written to `packages/abi`): belongs with the `packages/payment-client` prompt and needs new pinned digests for the "Overflow" domain.
- `fork/AusdGate.t.sol`: the spec's `test/fork/UsdcGate.t.sol` against live Base Sepolia USDC is a separate item before gate G1.
- Spec items marked (new): `reserve()/release()`, `reservedTotal`, escrow-factory payees, `PayeeFlagged`, `setEscrowFactory`, `setReservationWindow`. P1.5.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `forge build` | success; 16 forge-lint warnings in `OverflowTreasury.sol`, all heuristic (revert inside the ancestor walk, `Paid` after the token call, `block.timestamp` expiry comparisons, no zero-check in constructor, `setFloor` without event). All are the Leash design carried over; none changed. |
| `forge test` | 64 passed, 0 failed (2 scaffold, 8 USDC harness, 51 treasury unit, 3 adversarial) |
| `forge snapshot` | `.gas-snapshot` written; `test_depth1_root_pays` 315,391 gas whole-test |
| `forge test --gas-report` on `OverflowTreasuryTest` | `settle` min 38,081 / avg 116,752 / median 131,668 / max 225,817 over 50 calls (spec: re-measure vs ~144k on AUSD). `createChild` avg 182,891. |

### Open issues
- Forge lint warnings above are informational; if the team wants a clean `forge build`, add a `[lint]` exclusion in `foundry.toml` rather than reordering checks.
- `withdraw()` can take the balance below `floor` by design (owner action); invariant T4 states this.
- Invariant tests (`contracts/test/invariant/`) for T1, T2, T4, T5 are not written yet.
## 2026-10-24: `@overflow/schemas` shared types, state machine, chain config

### Built
- `packages/schemas/src/primitives.ts`: `AddressSchema`, `Bytes32Schema`, `HexSchema` (typed as viem `Address`/`Hex` via `z.custom`, so input and output types match), `UintStringSchema`/`AtomicAmountSchema` (decimal integer string, no leading zeros, at most uint256), `IsoDateTimeSchema`, `IsoDateSchema`, `IdSchema`, `USDC_DECIMALS`.
- `money.ts`: `toAtomic("8.40") -> "8400000"` by string arithmetic (rejects >6 decimals, signs, exponents, `.5`, `1.`, and `number` arguments at runtime), `formatUsdc`, `atomicToBigInt`, `bigIntToAtomic`, `sumAtomic`. No `Number` or float anywhere.
- `purchase.ts`: `PurchaseStatusSchema` (11 statuses), `ALLOWED_TRANSITIONS` table, `TERMINAL_STATUSES`, pure `canTransition`/`assertTransition` (`InvalidTransitionError` carries `from`/`to`), `PaymentPathSchema`, `AllocationSchema`, `PurchaseOrderSchema` with exactly the spec's fields plus a refinement that non-empty allocations sum to `amountAtomic`.
- `resource.ts`: `ResourceRequestSchema`, `ResourceListingSchema` (with `simulated` flag), `DateRangeSchema`, `GranularitySchema` + `GRANULARITY_ORDER`, `FormatSchema`, `LicenseSchema` (`unclear` allowed; Fusion treats it as no merge), `FreshnessSchema`.
- `mission.ts`: `MissionSchema`, `AgentNodeSchema` mirroring the onchain `Node` struct (`id`, `key`, `parent`, `depth` 0..2, `cap`, `spent`, `maxPerCall`, `expiry`, `paused`, `restricted`) plus optional offchain `agentId`/`department`.
- `ledger.ts`: `JournalEntrySchema` (double-entry; debits must equal credits; each line is a debit or a credit), `ActivityEventSchema` (with `decodedRevert` for the Blocked lane and `simulated`), `ExceptionRecordSchema`, `ControllerRequestSchema` (discriminated union of owner actions: set-allow, raise-cap, pause, unpause, set-floor, withdraw, set-escrow-factory).
- `hashing.ts`: `computeTermsHash`, `computeOrderId`, `hashIdToBytes32`, with the ABI parameter lists exported (`TERMS_HASH_ABI`, `ORDER_ID_ABI`) so the Solidity side can be checked against them.
- `chain.ts`: `CHAIN_ID`, `USDC` facts (address, name, version, decimals, domain separator, selector), `USDC_EIP712_DOMAIN`, `OVERFLOW_DELEGATION_DOMAIN`, `explorerUrl(kind, value)` for sepolia.basescan.org, `DeploymentsSchema`/`parseDeployments`/`loadDeployments` for `deployments/base-sepolia.json`.
- Dependencies: zod and viem only.

### Design choices
- **termsHash field order (contract must match):** `keccak256(abi.encode(address token, uint256 amount, uint256 bond, bytes32 manifestHash, bytes32 rootPlain, bytes32 rootCipher, bytes32 keyCommitment, uint64 revealDeadline, uint64 challengeWindow, address sourceKey, uint64 minTimestamp))`. Buyer, seller, missionId and resourceId are bound by `orderId`, so they are not repeated.
- **orderId (spec formula):** `keccak256(abi.encode(bytes32 missionId, bytes32 resourceId, address buyer, address seller, uint256 amount, bytes32 termsHash, bytes32 salt))`, where the offchain string ids become `bytes32 = keccak256(bytes(id))`. Fixed fields only, never JSON.
- Transition table: `PROPOSED -> RESERVED | REJECTED | FAILED_BEFORE_FUNDING`; `RESERVED -> PAYMENT_PENDING | RELEASED | REJECTED | FAILED_BEFORE_FUNDING`; `PAYMENT_PENDING -> ESCROW_FUNDED | PAYMENT_UNKNOWN | REJECTED | FAILED_BEFORE_FUNDING`; `PAYMENT_UNKNOWN -> ESCROW_FUNDED | FAILED_BEFORE_FUNDING` (reconcile only, never back to a payment state); `ESCROW_FUNDED -> DELIVERY_PENDING | REFUNDED`; `DELIVERY_PENDING -> SETTLED | REFUNDED`; the other five are terminal. 17 allowed pairs out of 121.
- `loadDeployments` imports `node:fs/promises` dynamically so `@overflow/schemas` stays importable from Next client bundles. Default path is `<repo>/deployments/base-sepolia.json`, overridable with `OVERFLOW_DEPLOYMENTS_PATH`.
- Zod 4 keeps running later checks after an earlier one fails, so the uint256/uint64 guards and the sum refinements re-validate before calling `BigInt()`.
- Intra-package imports are extensionless (`./chain`, not `./chain.js`): Turbopack does not map `.js` specifiers back to `.ts` sources under `transpilePackages`.
- `apps/web/tsconfig.json` target raised from ES2017 to ES2020 so `tsc` accepts bigint literals in the shared source it type-checks (Next's SWC output is unaffected).

### Stubbed or simulated
- `deployments/base-sepolia.json` does not exist yet; `loadDeployments` throws an error naming the path until the deploy script (P1.2) writes it.
- No schema here is wired to a database, API route or UI yet.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm install` | exit 0 |
| `pnpm test` | exit 0, 5 files / 103 tests passed (full 11x11 transition matrix, toAtomic edge cases, orderId/termsHash determinism and per-field sensitivity, viem `domainSeparator` == pinned USDC constant, deployments loader round-trip) |
| `pnpm typecheck` | exit 0, 8 workspaces Done |
| `pnpm --filter @overflow/web build` | exit 0, compiled, 2 static routes |

### Open issues
- `pnpm --filter @overflow/schemas test` fails at startup because Vitest in a package directory picks up the root `projects` config and resolves `apps/service` relative to the package. Run `pnpm test` from the root (or add a per-package `vitest.config`) until the scaffold is adjusted.
- Engineer B must copy the `termsHash` and `orderId` field orders above into `OverflowEscrowFactory`/`OverflowEscrow` and add a golden-vector test against `computeOrderId`.

## 2026-10-24: deploy, verify, export addresses (tooling complete; live deploy NOT yet run)

### Built
- `contracts/script/Deploy.s.sol`: deploys `OverflowTreasury(TOKEN_ADDRESS, OWNER_ADDRESS)` on chain 84532 only; signer comes from the CLI (`--account <keystore>`), no key is read in Solidity. When `owner == deployer` it calls `createRoot(AGENT_ROOT_ADDRESS, ROOT_CAP, ROOT_MAX_PER_CALL, ROOT_EXPIRY)` (defaults 50 USDC, 15 USDC, now + 7 days); otherwise it prints the `createRoot` calldata for the controller's Coinbase Wallet. The escrow implementation/factory and `setEscrowFactory` do not exist yet (P1.5/P1.6); the script carries a marked hook and the export writes `null` for both.
- `scripts/` is a workspace package `@overflow/scripts` (tsx, viem, `@overflow/schemas`): `deploy.sh` (one command: `forge script --broadcast --verify` with `--account`/`--password-file`, `DRY_RUN=1` simulates with `--sender`, interactive password prompt if no password file, prints the `forge verify-contract` retry on failure, then exports), `export-deployment.ts` (reads `contracts/broadcast/Deploy.s.sol/84532/run-latest.json`, writes `packages/schemas/deployments/base-sepolia.json` with `{chainId, token, usdc, treasury, escrowFactory, escrowImplementation, owner, deployer, deployBlock, deployedAt, txs}`, generates `packages/schemas/src/abi/<Name>.ts` `as const` ABIs plus barrel and `src/deployments.ts`; `--abi-only` regenerates ABIs without a broadcast), `status.ts` (balance, owner, TOKEN, floor, nodeCount, per-node `remaining()`, exits non-zero if `TOKEN()` differs from the file), `dev-fund.ts` (DEV ONLY banner; checks the deployer's USDC balance, then `cast send transfer(...)` through the keystore so no key enters Node).
- Root scripts: `contracts:deploy`, `contracts:export`, `status`, `dev:fund`. `.env.example` gains `DEPLOYER_ACCOUNT`, `DEPLOYER_PASSWORD_FILE`, `DEPLOYER_ADDRESS`, `AGENT_ROOT_ADDRESS`, `ROOT_CAP`, `ROOT_MAX_PER_CALL`, `ROOT_EXPIRY`, `DRY_RUN`.
- `packages/schemas`: `DeploymentsSchema` extended as a superset of the P0.2 version (`token`, `owner`, `deployer`, `escrowImplementation`, nullable `escrowFactory`, `txs`; `usdc` and `txHashes` kept), `defaultDeploymentsPath()` now resolves to `packages/schemas/deployments/base-sepolia.json` (the prompt's path; the P0.2 test asserting the repo root was updated), new `./chain` subpath export so scripts can import chain facts before the generated `abi/` exists, `src/abi/OverflowTreasury.ts` (52 ABI entries) exported from the package index.

### Design choices
- Signing uses Foundry keystores (`overflow-deployer`) plus a chmod-600 password file instead of a raw key in `.env`; the `*_KEY` slots in `.env` hold addresses only.
- The deployments JSON lives in `packages/schemas/deployments/` (prompt) rather than the repo root (P0.2 draft) so the package can import it statically; field names follow the prompt, P0.2 names stay accepted.
- `dev-fund` is labeled DEV ONLY in code and output; in the demo the controller funds through Coinbase Wallet.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `forge build` | success (Deploy.s.sol compiles) |
| `DRY_RUN=1 pnpm contracts:deploy` (simulation with `--sender 0xB6F4…06C3`) | `Script ran successfully`; treasury would be `0xd3A74fA991CA0B5627d30EF27dC699C134848291` at the deployer's current nonce, root node id 1 (key `0x390C…Ea89`, cap 50 USDC, maxPerCall 15 USDC); estimated 2,758,876 gas, 0.000030347636 ETH |
| `pnpm contracts:export --abi-only` | wrote `packages/schemas/src/abi/OverflowTreasury.ts` (52 entries); skipped escrow artifacts (not built yet) |
| `pnpm typecheck` | exit 0, 9 workspaces Done (incl. `scripts`) |
| `pnpm test` | exit 0, 5 files / 104 tests (deployments schema superset and new default path covered) |
| `pnpm contracts:test` | 64 passed, 0 failed |
| `pnpm lint` | exit 0 |
| `git grep -nE "0x[a-fA-F0-9]{64}"` | only typehashes/domain separators; no private keys |

### Deployed (Base Sepolia, 2026-10-25 01:29 UTC, run by the user with the keystore)
| Item | Value |
|---|---|
| OverflowTreasury | `0xd3A74fA991CA0B5627d30EF27dC699C134848291` (https://sepolia.basescan.org/address/0xd3a74fa991ca0b5627d30ef27dc699c134848291) |
| deploy tx | `0x5a78240fc7d6bdb5135332dbbf37dd9d17f8aaaca8335c3627d45a48678ad845`, status 0x1, block 49849422, 1,944,133 gas |
| createRoot tx | `0x97b3b51bdda633d98966ed6dcf2809ad26dfeb5ae2fcd9355853a8490bc7143f`, status 0x1, block 49849422, 167,605 gas |
| owner / deployer | `0xB6F4162192F753C9998B63893CBb48FA046906C3` |
| TOKEN | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Base Sepolia USDC) |
| root node 1 | key `0x390CF9aA0230728dB7E185782F2288E41892Ea89`, cap 50 USDC, maxPerCall 15 USDC, expiry 2026-11-01T01:28:38Z |
| Basescan source | verified: `OverflowTreasury`, solc v0.8.28, cancun, optimizer 200 runs (Etherscan v2 `getsourcecode`, status 1) |
| escrowFactory / escrowImplementation | `null` (P1.6) |

The first export run failed in `parseDeployments` with `Invalid ISO datetime` on `deployedAt`: forge writes the
broadcast `timestamp` in milliseconds (1792891768225) and `export-deployment.ts` multiplied it by 1000 again
(year 58785). Fixed by treating values above 1e12 as milliseconds; nothing was re-broadcast. Regenerated from the
existing `run-latest.json`: `packages/schemas/deployments/base-sepolia.json`, `src/deployments.ts`
(`BASE_SEPOLIA_DEPLOYMENT`) and the three ABIs. Live-chain check: code size 8,747 bytes at the address, `owner()`,
`TOKEN()`, `nodeCount() == 1`, `remaining(1) == 50000000`, both receipts status 0x1, all equal to the JSON.

`pnpm status` (block 49855168): balance 0.00 USDC, owner and TOKEN as above, floor 0, nodeCount 1, node 1 remaining
50.00 USDC. `pnpm typecheck` exit 0 (9 workspaces), `pnpm test` 6 files / 112 tests passed.

### Open issues
- Treasury holds 0 USDC; `pnpm dev:fund` needs test USDC on the deployer (faucet.circle.com), or the controller funds via Coinbase Wallet in the demo.
- `escrowFactory`/`escrowImplementation` stay `null` until the escrow contracts are added to `Deploy.s.sol` (P1.6).

## 2026-10-24: escrow factory and tier-1 escrow

### Built
- `contracts/src/IOverflowEscrow.sol`: spec `OrderTerms` (15 fields) plus `uint32 chunkCount`, `Status {Created, Funded, Revealed, Settled, Refunded}`, 16 errors, 5 events.
- `contracts/src/OverflowEscrowFactory.sol`: `create(OrderTerms)` deploys an OpenZeppelin `Clones` minimal proxy with CREATE2, salt `keccak256(abi.encode(orderId, termsHash))`, after checking the terms and `termsHash == termsHashOf(t)`; `predict`, `isEscrow`, `termsHashOf`, `provenCheats`, `recordCheat` (escrows only), `OrderCreated`/`CheatRecorded`. The implementation is deployed by the factory constructor with `FACTORY` as an immutable.
- `contracts/src/OverflowEscrow.sol`: `initialize` (factory only, once; the implementation is pre-marked initialized), `markFunded` (balance >= amount + bond), `revealKey` (seller, before `revealDeadline`, `keccak256(key) == keyCommitment`, opens the challenge window), `accept` (EIP-712 `Accept(bytes32 orderId)` under the clone's own domain `{OverflowEscrow, 1, chainId, escrow}`, signer must be a node of `terms.buyer` via `nodeOfKey`), `finalizePayout` (after the window), `claimTimeoutRefund` (after `revealDeadline`, from `Created` or `Funded`, whole balance to the buyer). Payout sends `amount + bond` to the seller and any surplus to the buyer so the escrow ends at zero. `SafeERC20`, `ReentrancyGuardTransient`, effects before transfers.
- `complainMismatch` / `complainPromise` are stubs that enforce the full structure (`i < chunkCount`, chunk length 160, proof length exactly `expectedProofLength(i, chunkCount)`, domain-separated Merkle verification) and then revert `NotImplemented` (P1.6 / P1.7 fill them in).
- `contracts/src/MerkleLib.sol`: `leaf = keccak256(0x00 || data)`, `node = keccak256(0x01 || l || r)`, left-to-right levels with an unpaired last node promoted unhashed, so `expectedProofLength(i, n)` depends on `i` (n = 5 gives 3,3,3,3,1). `verify` requires every proof element to be consumed.
- `packages/recourse-crypto/src/merkle.ts` mirrors it (`hashLeaf`, `hashNode`, `expectedProofLength`, `merkleRoot`, `merkleProof`, `verifyProof`, `keyCommitment`, `CHUNK_SIZE`); golden roots for n = 1..5, the n = 5 proofs and the proof-length table are pinned identically in `merkle.test.ts` and `contracts/test/escrow/MerkleLib.t.sol`.
- `packages/schemas/src/hashing.ts`: `TERMS_HASH_ABI` and `TermsHashInputSchema` gain `uint32 chunkCount` (12 fields) to match `OverflowEscrowFactory.termsHashOf`; `hashing.test.ts` updated.
- `foundry.toml`: `[invariant] runs = 64, depth = 32`. ABIs exported to `packages/schemas/src/abi/OverflowEscrow.ts` and `OverflowEscrowFactory.ts`.
- Tests: `contracts/test/escrow/EscrowBase.t.sol` (harness over the treasury harness: Merkle builder, order terms, funding via mint or via `treasury.settle` with the escrow as payee), `OverflowEscrow.t.sol` (41 tests), `MerkleLib.t.sol` (6), `contracts/test/invariant/EscrowInvariant.t.sol` (handler drives markFunded / reveal / accept / finalize / timeoutRefund / warp / topUp; invariants: at most one terminal state, zero balance after it, funds only to seller or buyer).

### Design choices
- The Accept digest is bound to the clone address through the per-escrow EIP-712 domain, so a signature for one order cannot pay another (`test_accept_signatureForAnotherEscrowReverts`). The offchain signer (payment-client / service) must use `{name "OverflowEscrow", version "1", chainId 84532, verifyingContract = escrow}`.
- `chunkCount` is bound by `termsHash` (and therefore by `orderId` and the CREATE2 salt), per the user's decision; the teammate's `TERMS_HASH_ABI` was extended as a superset.
- A refund returns price and bond to the treasury's USDC but leaves the paying node's `spent` charged (asserted in `test_timeoutRefund_restoresTreasuryUsdc`), per the spec's refund semantics.
- The internal-node-as-leaf attack fails on the exact proof-length check first and on the domain-separated hash if padded; a 32-byte node can never pass as a 160-byte chunk either.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `forge build` | success |
| `forge test` | 112 passed, 0 failed across 7 suites (2 scaffold, 8 USDC harness, 51 treasury, 3 adversarial, 41 escrow, 6 MerkleLib, 1 invariant contract with 3 invariants: 64 runs, 2,048 calls) |
| `forge snapshot` | `.gas-snapshot` refreshed (114 lines) |
| `pnpm test` | 6 files / 112 tests passed (schemas hashing with `chunkCount`, recourse-crypto Merkle golden vectors identical to the Solidity constants) |
| `pnpm typecheck` | exit 0, 9 workspaces |
| `pnpm lint` | exit 0 |
| `git grep -nE "0x[a-fA-F0-9]{64}"` | only typehashes, domain separators and golden vectors; no private keys |

### Open issues
- Treasury side still pending (P1.5): `setEscrowFactory`, accepting factory escrows as payees, `PayeeFlagged`, `reserve`/`release`. Tests allowlist the escrow with `setAllow` meanwhile.
- Tier 2/3 complaint logic (decrypt and compare, source signature and timestamp, bond to the buyer, `recordCheat` call) is not implemented; the stubs revert `NotImplemented` after the structural checks.
- The chunk keystream (`k_i`, keystream blocks, XOR) is not in `recourse-crypto` yet; only the Merkle and key-commitment helpers are.
- Base Sepolia deploy of the treasury (previous section) is still pending the keystore password; `Deploy.s.sol` does not deploy the escrow contracts yet (its hook is marked).

## 2026-10-24: treasury pays per-order escrows

### Built
- `OverflowTreasury.setEscrowFactory(address)` (owner only, `EscrowFactorySet`), `escrowFactory` view; zero disables escrow payees.
- `_authorize` step 4: a payee passes if `allowlist[to]`, or if all of `factory.isEscrow(to)`, `escrow.buyer() == address(this)`, `factory.provenCheats(escrow.seller()) == 0` and `value == escrow.amount()`. Failures: `PayeeNotAllowed(0)` (not an escrow, factory unset, other buyer), `PayeeFlagged(seller)` (flag, checked before the amount), `EscrowAmountMismatch(escrow, expected, actual)` (new error, so the Blocked lane can name the cause instead of a generic `PayeeNotAllowed(0)`). Direct payees with `provenCheats > 0` also revert `PayeeFlagged(to)`. Check order 1-8 of the spec is unchanged.
- Step 5: restricted nodes are checked against the escrow's seller (`nodeAllow[n][escrow.seller()]`), so a delegation that allows a seller covers every per-order escrow of that seller. Documented as T15 in `docs/contract-invariants.md`; T14 and E9 now point at the implementation.
- `OverflowEscrow` gains `buyer()`, `seller()`, `amount()` getters (the treasury uses them). Treasury ABI re-exported (57 entries).
- `contracts/test/unit/TreasuryEscrowPayee.t.sol` (12 tests, real USDC): agent funds an escrow through `settle()` with no `setAllow`, then `markFunded`; wrong amount (both directions, no partial charge); escrow with a different buyer; flagged seller on the escrow path, on a fresh order, and on the direct path; other sellers unaffected; factory unset; owner-only `setEscrowFactory` with event; restricted child pays an escrow of its allowed seller, rejects another seller's escrow (also through an unrestricted grandchild), and an allowlist of `payeeA` does not admit the escrow.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `forge build` | success |
| `forge test` | 124 passed, 0 failed (51 existing treasury tests untouched and green, 12 new, 41 escrow, 6 Merkle, 3 invariants, 8 USDC, 3 adversarial) |
| `forge snapshot` | refreshed; `test_depth1_root_pays` 315,391 -> 317,607 gas (one `escrowFactory` SLOAD on the allowlisted path) |
| `pnpm typecheck` / `pnpm test` / `pnpm lint` | exit 0 / 6 files, 112 tests / exit 0 |

### Open issues
- The live Base Sepolia treasury (`0xd3A7…8291`) predates `setEscrowFactory`; it must be redeployed together with the escrow factory (P1.6 `Deploy.s.sol` hook) before escrow payments can run on chain.
- Reservations (`reserve`/`release`, `reservedTotal` in the floor check) remain P1.5+.

## 2026-10-24: reservations for third-party facilitators (P1.5)

### Built
- `reserve(to, value, validAfter, validBefore, nonce, sig) -> digest`: same digest, signer recovery and `_authorize` as `settle()` (every policy check, every ancestor charged), plus `validBefore <= block.timestamp + reservationWindow` (`ReservationTooLong`) and one reservation per digest (`ReservationActive`). Stores `Reservation {nodeId, value, validBefore, nonce}`, `reservedTotal += value`, emits `Reserved(digest, id, to, value, validBefore, nonce)`.
- Floor check in `_authorize` is now `balance >= value + floor + reservedTotal` for both `settle()` and `reserve()`.
- `isValidSignature` stays `view`: magic value when `msg.sender == TOKEN` and either the transient settle flag is set or a stored reservation for that exact digest has `block.timestamp < validBefore`.
- `release(digest)`: anyone, after `validBefore` (`ReservationLive` before, `NoReservation` for unknown or already released). If `USDC.authorizationState(this, nonce)` is false the charge is reversed up the stored node's ancestor chain; always `reservedTotal -= value`, delete, `ReservationReleased(digest, refunded)`.
- Owner `setReservationWindow(seconds)` (`ReservationWindowSet`), default 600. Views `reservedTotal`, `reservationWindow`, `getReservation(digest)`. The digest computation moved into `_twaDigest` (shared by `settle` and `reserve`); check order 1-8 unchanged.
- Treasury ABI re-exported (70 entries).
- `contracts/test/unit/Reservations.t.sol` (16 tests, real USDC v2.2): after `reserve` a third-party address calls `USDC.transferWithAuthorization` directly and it succeeds, replay is refused by USDC's nonce; without `reserve` the same call fails `FiatTokenV2: invalid signature` and then succeeds once reserved; an expired reservation is refused by USDC (`authorization is expired`) and by the 1271 gate, and `release` refunds the budget; a used reservation releases without refund; refund walks the whole ancestor chain; release before `validBefore`, unknown digest and double release revert; duplicate `reserve` reverts and `settle` of a reserved digest cannot double-charge; `ReservationTooLong` with owner widening; disallowed payee, unknown agent, `OverPerCall`, `OverBudget`, `Paused` all revert at `reserve`; the floor counts `reservedTotal` and room returns after release; the 1271 reservation branch is token-only and digest-exact. Escrow integration: a facilitator funds a per-order escrow from a reservation and the seller is paid after reveal + accept; wrong amount and another buyer's escrow revert at `reserve`; seller silent -> timeout refund restores USDC but not allowance, used reservation releases without refund; funding never happens -> `release` restores the budget and the empty escrow still closes; a reservation for one escrow cannot fund another (USDC rejects the changed `to`).

### Live treasury compatibility
The Base Sepolia treasury at `0xd3A74fA991CA0B5627d30EF27dC699C134848291` was checked by selector against its bytecode: it has `settle` and `isValidSignature` but lacks `reserve`, `release`, `setEscrowFactory`, `reservedTotal` and `setReservationWindow`. It has no proxy, so it cannot be upgraded; it must be replaced by a fresh deployment (with the escrow factory, P1.6 hook in `Deploy.s.sol`). Not done in this task; nothing was broadcast.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `forge build` | success |
| `forge test` | 140 passed, 0 failed across 9 suites (51 original treasury tests unchanged) |
| `forge snapshot` | refreshed; `test_depth1_root_pays` 317,607 -> 319,816 gas (reservedTotal SLOAD + reservation SLOAD in the gate) |
| `pnpm typecheck` / `pnpm test` / `pnpm lint` | exit 0 (9 workspaces) / 6 files, 112 tests / exit 0 |

### Open issues
- Redeploy the treasury + escrow factory to Base Sepolia and record the new addresses (replaces `0xd3A7…8291`).
- The service's Coinbase-facilitator path must call `reserve()` before handing the authorization to the facilitator, and `release()` after `validBefore`; `Paid` is not emitted for reserved payments, so the ledger must watch USDC `Transfer`/`AuthorizationUsed` instead.
- Treasury invariants T1, T2, T4, T13/T16 still lack Foundry invariant handlers (only the escrow has them).

## 2026-10-24: tier-2 mismatch proofs (P1.6)

### Built
- `contracts/src/RecourseCrypto.sol`: `deriveKey(sellerSecret, orderId, buyer) = keccak256(abi.encodePacked(...))`, `keyCommitment(k) = keccak256(k)`, `chunkKey(k, i) = keccak256(abi.encodePacked(k, uint256 i))`, `keystreamBlock(k_i, j) = keccak256(abi.encodePacked(k_i, uint256 j))`, `xorChunk(k_i, chunk)` over exactly 160 bytes (5 x 32-byte blocks, assembly XOR). Merkle rules stay in `MerkleLib` (domain-separated `0x00` leaf / `0x01` node, unpaired node promoted, index-dependent proof length) per the extra requirement; the prompt's plain `keccak256(chunk)` / `keccak256(left, right)` wording is superseded by that requirement, as in P1.3.
- `OverflowEscrow.complainMismatch`: `Revealed` and inside the window, `i < chunkCount`, 160-byte chunk, both proof lengths exact, both proofs verified; then `k_i` from `revealedKey`, decrypt, and if `leaf(plaintext) != plainLeaf`: `status = Refunded` (effect first), `CheatProven(seller, i)`, `factory.recordCheat(seller)`, whole balance (price + bond + surplus) to the buyer, `Refunded("mismatch")`. Matching chunk reverts `ChunkMatches`. `complainPromise` remains the tier-3 stub (structural checks, then `NotImplemented`).
- `packages/recourse-crypto`: `src/crypto.ts` (`deriveKey`, `chunkKey`, `keystreamBlock`, `xorChunk`, `encryptChunk`/`decryptChunk`, `commitDelivery` -> `{keyCommitment, rootPlain, rootCipher, plainLeaves, cipherChunks, cipherLeaves, chunkCount}`, `chunkMatches`, `recordTimestamp`, `RECORD_LAYOUT`), `README.md` (record byte layout: 95-byte payload whose first 8 bytes are a big-endian uint64 timestamp + 65-byte signature; keystream; Merkle rules; complaint flow), `src/crypto.test.ts`.
- Golden vectors (KEY = `keccak256("overflow.golden.key")`, chunk i = 160 bytes of value i, n = 5) pinned identically in `contracts/test/escrow/RecourseCrypto.t.sol` and `crypto.test.ts`: `k_0`, `k_2`, `ks_0_0`, `ks_0_4`, full `c_0` and `c_2`, `keyCommitment`, `rootPlain`, `rootCipher`, cipher leaf 0, `deriveKey` vector.
- Test harness `EscrowBase` now commits real ciphertext (`_cipher(i)`, `_cipherLeaves(n)`); existing complaint-structure tests moved onto it (`test_complaint_wellFormed_honestSeller` now expects `ChunkMatches` for tier 2 and `NotImplemented` for tier 3).
- `contracts/test/escrow/EscrowMismatch.t.sol` (7 tests): a seller commits honest plaintext hashes but serves a swapped ciphertext for chunk 2; the treasury funds the escrow through `settle()`; the proof refunds price + bond to the treasury, flags the seller, leaves the agent's allowance charged; a correct chunk complaint reverts (cheating and honest sellers); complaints before reveal and after the window revert and an unchallenged cheat pays out; a second complaint after the refund reverts; tampered chunk or foreign plain leaf revert `BadProof`; internal-node-as-leaf reverts (length, then hash); the flagged seller is then blocked by the treasury for new escrows via `settle` and `reserve` and for direct payment (P1.4 `PayeeFlagged`).
- Escrow ABI re-exported (52 entries).

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `forge build` | success |
| `forge test` | 153 passed, 0 failed across 11 suites (7 mismatch, 6 RecourseCrypto golden/fuzz, 51 original treasury unchanged) |
| `forge snapshot` | refreshed; `test_swappedChunk_refundsBuyerAndFlagsSeller` 890,194 gas whole-test |
| `pnpm test` | 7 files / 118 tests (6 new crypto tests; TS and Solidity golden constants identical) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |

### Open issues
- Tier 3 (`complainPromise`: source signature over the 95-byte payload, `minTimestamp`, bond flows) is not implemented.
- The live Base Sepolia treasury and no escrow contracts are deployed with this code; redeploy pending (see P1.5 section).
- Sampling (`k_i` reveal for random indices before funding) is an offchain protocol in the service, not yet built.

## 2026-10-24: signed-record promises, bonds, cheater flags (P1.7)

### Built
- `RecourseCrypto.splitRecord(record) -> (payload[0:95], sig[95:160])`, `recordTimestamp(payload)` (big-endian uint64 in the first 8 bytes), `payloadHash(payload) = keccak256(payload)` (plain, no EIP-191 prefix; the data source signs raw keccak of the payload).
- `OverflowEscrow.complainPromise(i, plainChunk, plainProof)`: window + structural checks as tier 2, record verified under `rootPlain`; then `broken = (sourceKey != 0 && tryRecover(payloadHash, sig) != sourceKey) || (minTimestamp != 0 && ts < minTimestamp)`. A malformed signature (ECDSA error) counts as a wrong source. Terms that promise nothing (`sourceKey == 0 && minTimestamp == 0`) revert `NoPromise` so a vacuous promise can never be used to drain an honest seller; a kept promise reverts `PromiseKept`. Both tiers share `_proveCheat(i, reason)`: `status = Refunded` first, `CheatProven`, `factory.recordCheat`, sweep price + bond + surplus to the buyer, `Refunded(reason)`.
- `OverflowEscrowFactory.create` reverts `SellerFlagged(seller)` when `provenCheats[seller] != 0`. Combined with P1.4 (`PayeeFlagged` in the treasury) a flagged seller can neither open new orders nor be paid for existing ones.
- Bonds were already enforced by P1.3 (`markFunded` requires price + bond; payout sends both to the seller; refund/timeout sweep everything to the buyer). This task adds the explicit flow tests; no contract change was needed.
- `@overflow/recourse-crypto`: `splitRecord`, `buildRecord`, `buildPayload(timestamp, 87 data bytes)`, `payloadHash`, `promiseBroken(record, sourceKey | null, minTimestamp)` (offchain mirror of the contract's decision, viem `recoverAddress`), README section for tier 3. `recordTimestamp` accepts a record or a bare payload.
- Tests: `contracts/test/escrow/EscrowPromise.t.sol` (13): wrong-source record refunds (treasury funded via `settle`, bond to the buyer, allowance stays charged, anyone may relay), stale record refunds, malformed signature refunds, valid record complaint reverts for every chunk and a forged record fails `BadProof`, timestamp-only promise ignores the signer, no-promise terms revert, complaints before reveal / after the window revert, bond to seller on payout, bond to buyer on cheat, bond to buyer on ghost (no cheat flag), `markFunded` underfunded without the bond, flagged seller cannot create (`SellerFlagged`, no clone deployed) or be paid (earlier order and direct), cheat count accumulates across orders. `TreasuryEscrowPayee::test_flaggedSeller_escrowPathReverts` updated for the new create rule; `test_complaint_wellFormed_honestSeller` now expects `NoPromise` for tier 3. ABIs re-exported (escrow 53 entries, factory 17).

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `forge build` | success |
| `forge test` | 166 passed, 0 failed across 12 suites |
| `forge snapshot` | refreshed; `test_wrongSourceRecord_refunds` 2,317,848 gas whole-test (incl. order creation and treasury funding) |
| `pnpm test` | 7 files / 122 tests (4 new: record split, promise kept/broken/malformed, empty promise rejected) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |

### Open issues
- `sourceKey` is a single EOA per order; a source that rotates keys needs a new order or an onchain registry (not in spec).
- Offchain: the service does not yet build or verify records (`buildPayload`/`buildRecord` exist; the seller simulation and sampling protocol are P2).
- Live Base Sepolia treasury predates escrow support; redeploy pending.

## 2026-10-24: fork suite, invariants, gas report (P1.8)

### Built
- `contracts/test/fork/UsdcGate.t.sol` (6 tests, `vm.skip` unless chain id 84532): a fresh treasury on a Base Sepolia fork over the real USDC at `0x036C...`, funded with `deal()` (no keys). Domain name "USDC" / version "2" / separator `0x71f1...9818` / 6 decimals; settle moves balances and marks the nonce; a direct `transferWithAuthorization` from anyone reverts `FiatTokenV2: invalid signature`; replay reverts `FiatTokenV2: authorization is used or canceled` with no second charge; the ERC-1271 gate answers INVALID to USDC and to anyone outside settle, and stays closed after an unrelated settle; a reservation lets a facilitator submit the agent's authorization straight to live USDC, and `release` after the window keeps the charge. The live treasury `0xd3A7...8291` is not used (it predates `reserve`); the suite deploys its own.
- `scripts/fork-test.sh` -> `pnpm contracts:fork` (sources `.env`, needs `BASE_SEPOLIA_RPC_URL`, read-only `forge test --fork-url`).
- `contracts/test/invariant/TreasuryInvariant.t.sol`: `TreasuryHandler` with 16 actions (settle, reserve, executeReservation as a facilitator via USDC, release, warp, ownerPause, pauseChild by the root key, delegate with caps that sometimes exceed the parent, fundTreasury, createEscrow with bond staked by the seller, markFunded, reveal correct/wrong, accept by any node key, finalize, timeoutRefund, flagSeller as a SIMULATED proven cheat through `recordCheat`). Targets mix allowlisted payees, escrows (value forced to the order amount) and never-allowlisted sellers. Invariants: `spent <= cap` and `spent >= sum of children` on every node; `balance + executedPending >= floor + reservedTotal` (executedPending = reserved USDC a facilitator already pulled but nobody released yet, which stays in `reservedTotal` by design); `reservedTotal == sum of unreleased reservations`; the gate returns MAGIC only to USDC and only for a live reservation digest, INVALID to every other caller and for unknown digests; every escrow has at most one terminal transition, a final terminal status and zero balance afterwards (one tracked exception: a reservation approved while the order was open and executed by the facilitator after it closed); the treasury never authorizes a payment benefiting a flagged seller and the factory refuses them. `afterInvariant` logs per-run coverage; `test_handlerCoverage` runs a deterministic 400-step walk and asserts settles, reserves, treasury-funded escrows, delegations, terminal escrows and flagged sellers all occurred, then re-checks every invariant.
- `foundry.toml` `[invariant]` now `runs = 256`, `depth = 50` (whole forge suite ~6 s). `pnpm contracts:invariant` runs the two invariant suites.
- `contracts/test/gas/GasReport.t.sol` + `scripts/gas-report.ts` -> `pnpm contracts:gas` writes `docs/gas.md` from forge gas snapshots (`contracts/snapshots/`, gitignored): settle, reserve, release, escrow create, fund (settle to escrow + markFunded), reveal, accept, refund.

### Fix found by the invariants
- The treasury would pay a settled or refunded escrow (the payee rule checked factory, buyer, seller flag and amount but not status). A closed escrow has no sweep, so the USDC would be stranded and the agent's allowance burned. `_authorize` now reverts `EscrowClosed(escrow)` inside the escrow branch of step 4; the normative check order is unchanged. Unit test `test_closedEscrow_isNotAPayee` (settle and reserve). Treasury ABI re-exported (71 entries).
- Not fixed, documented: a reservation approved while an order was open can be executed by the facilitator after the order closes, landing USDC in the closed escrow with no sweep. Candidate P2 fix: an escrow `sweep()` to the buyer after a terminal state.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm contracts:fork` (live Base Sepolia RPC) | 6 passed, 0 failed |
| `forge test` (invariants at 256 runs x depth 50) | 170 passed, 0 failed, 1 skipped (the fork suite off-chain) across 15 suites; treasury invariants also pass under fuzz seeds 1, 2, 3 |
| handler metrics (`FOUNDRY_INVARIANT_SHOW_METRICS`) | 12,800 calls per invariant, every action called ~800 times |
| `pnpm contracts:gas` | docs/gas.md: settle 170,063; reserve 198,444; release 56,011; escrow create 420,958; fund settle 155,912 + markFunded 69,134; reveal 62,855; accept 100,705; refund 61,463 |
| `forge snapshot` | refreshed |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` | 122 tests / exit 0 / exit 0 |

### Open issues
- Late-executed reservation into a closed escrow (above).
- The fork suite deploys a fresh treasury; the live `0xd3A7...8291` still needs replacing by a deployment with the escrow factory.

## 2026-10-24: facilitator and relayer (P2.1)

### Built
- `@overflow/payment-client` (`src/typed-data.ts`): EIP-3009 `TransferWithAuthorization` types, `authorizationDigest`, `signAuthorization`/`recoverAuthorizationSigner` (structural `TypedDataSigner`), `randomNonce`; treasury delegation types `CreateChild`/`PauseChild`, `delegationDomain(treasury)`, `payeesHash`, `createChildDigest`/`pauseChildDigest` + signers; `AuthorizationSchema`, `ChildParamsSchema`, `PauseChildSchema`, `SignatureSchema`; `verifyTokenDomain(reader)` reads `name()/version()/decimals()/DOMAIN_SEPARATOR()` (USDC has no `eip712Domain()`) and throws `TokenDomainMismatch` listing every differing field. Golden vectors (USDC separator, one authorization digest, delegation separator for the live treasury address, payeesHash, CreateChild and PauseChild digests) pinned in `contracts/test/unit/TypedDataVectors.t.sol` and `typed-data.test.ts`; the forge test also checks the treasury's own `DELEGATION_DOMAIN_SEPARATOR()` follows the same formula.
- `apps/service` (Hono + `@hono/node-server`):
  - `src/config.ts` zod env (`RELAYER_PRIVATE_KEY` must be a 64-hex key, validated and never logged; `DEMO_TOKEN` ≥ 16 chars required when `DEMO_MODE=true`; `EVENTS_POLL_MS`; `OVERFLOW_DEPLOYMENTS_PATH`), `loadEnv()`.
  - `src/chain/client.ts` `ChainClient` interface (the viem slice we use) + `viemChainClient`; `src/chain/boot.ts` `verifyBoot`: chain id 84532, USDC domain, deployments token == USDC, treasury code present, `treasury.TOKEN()`, `treasury.escrowFactory()` when recorded. Any mismatch → `BootCheckFailed`, process exits 1 before serving.
  - `src/facilitator/decode.ts`: viem `ContractFunctionRevertedError`, raw revert hex in `cause` chains, `Error(string)` (USDC messages → plain reasons; `FiatTokenV2: invalid signature` is the bypass reason), `Panic`, every treasury custom error (reason table also covers the OZ `ECDSA*`, `ReentrancyGuardReentrantCall`, `SafeERC20FailedOperation`, `Address*` errors present in the ABI); args as decimal strings / checksummed addresses.
  - `src/facilitator/relayer.ts`: one promise-chain lock per key around nonce fetch → send → receipt; local nonce re-synced after a send failure; receipt timeout → `status: "unknown"` with the hash kept (never resign). `src/facilitator/store.ts`: `Store` interface + `MemoryStore`, keyed by authorization digest / `release:<digest>` / delegation digest; a repeated key is 409 with the original record (also while pending). Front-run check: `authorizationState` true without a local record → scan `Paid`/`Reserved` logs (2000 blocks) and answer `success:true, external:true` with that tx.
  - Routes (`src/facilitator/routes/*`): `GET /health` (chain, treasury, relayer address and wei balance, pending/queued tx, demoMode), `GET /supported` (x402 v2 exact / eip155:84532 / USDC / payer = treasury), `POST /verify` (prechecks: `from == treasury`, requirements vs authorization, time window; recover payer; eth_call `settle` as the relayer; decoded reason), `POST /settle` and `POST /reserve` (x402 `paymentPayload`/`paymentRequirements` bodies; 409 replay; simulate; relay; parse `Paid`/`Reserved`; on receipt revert re-simulate at `block - 1`), `POST /release` (`ReservationReleased.refunded`), `POST /delegate` (`NodeCreated.id`), `POST /pause-child` (`NodePaused.by`), `GET /events` (SSE: subscribe-before-replay, 200-event ring, 15 s heartbeat; chain kinds from a treasury log poller, `Reverted`/`BypassRejected`/`BypassSucceeded` labeled `source: "facilitator"`). `POST /demo/bypass` and `forceBroadcast` exist only with `DEMO_MODE=true` and a timing-safe `x-demo-token`; both broadcast with fixed gas so the rejection lands onchain, and both responses/events carry `simulated: true`. No `/admin/*`.
  - `src/index.ts`: loadEnv → config → deployments → `verifyBoot` → relayer/bus/poller → serve; `GET /` keeps the status object.
- `contracts/script/Deploy.s.sol`: also deploys `OverflowEscrowFactory` (its constructor deploys the escrow implementation), `setEscrowFactory`, optional `setAllow(DEMO_PAYEE_ADDRESS)`, prints `setEscrowFactory` calldata when the owner is not the deployer. `.env.example`: `DEMO_PAYEE_ADDRESS`, `DEMO_TOKEN`, `EVENTS_POLL_MS`.
- `scripts/facilitator-demo.ts` → `pnpm demo:facilitator`: settle to the demo payee, `/verify` + forced `/settle` for the SIMULATED attacker, `/demo/bypass`, 409 replay; writes `docs/demo-facilitator.md` with Basescan links from real responses. `pnpm service` runs the service.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm test` | 13 files / 214 tests (service 80: decode covers every ABI error + every USDC message + viem shapes; routes via `app.request()` with a fake `ChainClient`: health, supported, verify valid/invalid/prechecks/400s, settle success/409 done/409 pending/policy revert/front-run/force 403/force demo/receipt timeout, reserve, release, delegate, pause-child, bypass gated and both outcomes; relayer serialization, nonce resync, timeout; bus/poller/SSE; boot checks. payment-client 12) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| `forge test` | 174 passed, 1 skipped (fork) incl. `TypedDataVectors` (4); `forge snapshot` refreshed |
| Service boot against Base Sepolia | **Not run**: `.env` `RELAYER_PRIVATE_KEY` holds an address (keystore convention), so `readConfig` refuses to start: `invalid service configuration: RELAYER_PRIVATE_KEY must be a 0x-prefixed 64-hex key` (exit 1). The wrong-token deployments negative check is covered by `boot.test.ts`. |
| `pnpm demo:facilitator` on Base Sepolia | **Not run**: needs the redeploy (`pnpm contracts:deploy` with `DEMO_PAYEE_ADDRESS`, then faucet USDC to the new treasury), a 64-hex `RELAYER_PRIVATE_KEY` with gas ETH, a 64-hex `AGENT_ROOT_KEY`, `DEMO_MODE=true`, `DEMO_TOKEN`, `ATTACKER_ADDRESS`. |

### Open issues
- Live proof pending the items above; after the redeploy the exporter must be rerun (`pnpm contracts:export`) so `base-sepolia.json` carries `escrowFactory`.
- Idempotency store is in-memory (lost on restart); the Postgres `reservations` table is the DB task's job.
- The facilitator does not yet call `release()` automatically after `validBefore`; the orchestration layer or a cron must.
- Coinbase facilitator path (reserve then hand off) is wired on the treasury side but untested against Coinbase's service.

## 2026-10-24: keystore signing for the relayer and the agent root key

### Built
- `@overflow/payment-client/keystore` (Node-only subpath, not exported from the package root): `decryptKeystore` (Web3 Secret Storage v3 as Foundry writes it: scrypt KDF with any `n/r/p`, aes-128-ctr, keccak MAC checked with `timingSafeEqual` before decrypting; derived key and plaintext buffers zeroed), `resolveKeystorePath` (`$FOUNDRY_KEYSTORES_DIR` or `~/.foundry/keystores/<name>`, absolute paths allowed, no `..`), `readPasswordFile` (refuses group/other-readable, empty or missing files; strips trailing newlines like `forge --password-file`), `resolveSigner({keyOrAddress, account, passwordFile, label})`: a 64-hex key in the env slot wins; otherwise the keystore is decrypted and, when the slot holds an address, the decrypted address must match it. The key exists only inside the returned viem account; no log, error or return value carries it.
- Service config: `RELAYER_PRIVATE_KEY` may be a 64-hex key or the relayer's address; `RELAYER_ACCOUNT` + `RELAYER_PASSWORD_FILE` select the keystore. `readConfig` refuses an address without a keystore. Boot logs `relayer <address> (keystore <name>)`. `createRelayer`, the nonce queue and `viemChainClient.sendTransaction` are unchanged: the account is still a viem `PrivateKeyAccount`.
- `scripts/facilitator-demo.ts` signs with `AGENT_ROOT_ACCOUNT` + `AGENT_ROOT_PASSWORD_FILE` (or a 64-hex `AGENT_ROOT_KEY`). `.env.example` documents both roles; README updated.
- Test fixture `packages/payment-client/test-fixtures/throwaway-a11ce`: a cast-generated keystore of the public `…a11ce` test key (README beside it).

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm test` | 15 files / 228 tests (keystore: decrypt, wrong password MAC, unsupported format, 0600 check, newline strip, path rules, signer precedence, address mismatch, missing pieces; config: signer source matrix) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| Service boot on Base Sepolia with the fixture keystore (`RELAYER_ACCOUNT=<fixture path>`, empty address slot) | booted; `/health` reports relayer `0xe05f…cfF7`, head block 49883826, boot log names the keystore and never a key |
| Wrong password / address slot ≠ keystore / password file 0644 | each exits 1: `keystore MAC mismatch`, `keystore … holds 0xe05f…, but the env slot says 0x1111…`, `password file … is readable by group/others; chmod 600 it` |
| The user's `overflow-relayer` / `overflow-agent-root` keystores | not opened: no password file exists yet (`DEPLOYER_PASSWORD_FILE` style). To use them: write the password to a chmod-600 file, set `RELAYER_PASSWORD_FILE` (and `AGENT_ROOT_PASSWORD_FILE`), keep the addresses in `RELAYER_PRIVATE_KEY` / `AGENT_ROOT_KEY` so boot checks them. |

### Notes
- Only scrypt keystores are accepted (what `cast wallet import` produces); pbkdf2 files fail loudly as unsupported rather than silently.
- Alternative considered and rejected: shelling out to `cast wallet sign` per transaction. `cast` cannot sign a raw transaction without broadcasting it, which would bypass the relayer's nonce queue and receipt tracking.

## 2026-10-24: sweep() for late USDC in closed escrows (security patch)

### Problem
`reserve()` approves an EIP-3009 authorization that USDC may execute later. `EscrowClosed` (T17) stops new `settle()`/`reserve()` calls to a settled or refunded escrow, but it cannot revoke an authorization USDC already accepts, so a facilitator executing a reservation after the order closed strands the USDC in the escrow. The treasury invariant tracked this as `lateDeposits`; the escrow had no path out.

### Built
- `OverflowEscrow.sweep() external nonReentrant returns (uint256)`: terminal status only (`BadStatus` otherwise), whole token balance to `terms.buyer` (fixed at creation: never the caller, seller or an owner), `NothingToSweep` on zero so a repeat cannot pay twice, `Swept(buyer, amount)` event. No state other than the token balance changes: terminal status, terms, `revealedKey`, the original payout/refund and the agent's spent allowance stay as they were. A transfer USDC rejects bubbles USDC's reason through SafeERC20 and leaves the balance recoverable. Interface: `sweep()`, `NothingToSweep()`, `Swept`. ABI regenerated (`OverflowEscrow.ts` 56 entries).
- Tests on the real USDC v2.2 harness, principal proof = a genuine late `transferWithAuthorization` of a previously valid `reserve()` authorization:
  - `Reservations::test_lateReservation_afterSettled_sweptToTreasury`: reserve, fund by a second `settle`, reveal, accept (Settled), `settle()` of the reserved authorization reverts `EscrowClosed`, a tampered copy reverts `invalid signature`, USDC executes the real one into the closed escrow, the seller calls `sweep()` and gains nothing, treasury gets the exact amount, `spent` stays 2 x AMOUNT, repeat sweep `NothingToSweep`, replay `authorization is used or canceled`, `release()` refunds no allowance.
  - `test_lateReservation_afterTimeoutRefund_sweptToTreasury` (Refunded via missed reveal, stranger sweeps, order not revived) and `EscrowMismatch::test_lateReservation_afterCheatRefund_sweptToTreasury` (Refunded via proven cheat, flagged seller gets nothing).
  - `test_lateReservation_rejectedTransfer_staysRecoverable`: USDC paused → `Pausable: paused`; treasury blacklisted → `Blacklistable: account is blacklisted`; status and balance untouched; sweep succeeds after `unBlacklist`. (`IUSDC` harness interface gained `unBlacklist`, `pause`, `unpause`.)
  - `OverflowEscrow.t.sol`: sweep in Created/Funded/Revealed reverts, empty terminal escrow reverts `NothingToSweep`, buyer-only recipient whoever calls, a swept Refunded order rejects every lifecycle call.
  - Invariants: `EscrowInvariant` handler gains `lateArrival` (terminal only) and `sweep`; `invariant_zeroBalanceAfterTerminal` asserts balance == unswept late arrivals. `TreasuryInvariant` handler gains `sweepEscrow` (also in the coverage walk) and the `sweptMoreThanLate` flag asserted false.
  - Fork: `test_fork_lateReservationIntoClosedEscrow_isSwept` against live Base Sepolia USDC.
- `docs/contract-invariants.md`: E2/E3 reworded, new E14, T17 note; `docs/gas.md` row `sweep()` = 55,904 gas.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `forge test` | 181 passed, 0 failed, 1 skipped (fork suite off-chain). One run hit a pre-existing flake in `RecourseCrypto.t.sol::test_xorRoundTrip` (`vm.assume` rejected too many inputs); it passed on the next two runs and is unrelated to this patch. |
| `pnpm contracts:invariant` | EscrowInvariant 256 runs x 12800 calls, TreasuryInvariant 256 runs x 12800 calls, `test_handlerCoverage`: all pass |
| `pnpm contracts:fork` (live Base Sepolia RPC) | 7 passed including the new late-reservation sweep |
| `pnpm contracts:gas` / `forge snapshot` | docs/gas.md 10 rows, `.gas-snapshot` refreshed |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` | 228 passed / exit 0 / exit 0 |
| Broadcasts, deploys, secrets | none |

### Follow-up for the service engineer
- Index the escrow `Swept(address buyer, uint256 amount)` event (the facilitator's log poller currently watches treasury logs only) and reconcile each sweep against the purchase ledger: the recovered USDC is a treasury credit for an order that already closed, and the agent's allowance is **not** restored (consumed nonce), so the ledger must show the budget as spent with the USDC returned.
- Consider having the facilitator call `sweep()` automatically when it observes a `Transfer` into a terminal escrow, and `release()` after `validBefore`, so recovery does not depend on a manual caller.

### Still open (not fixable by sweep)
- ~~The treasury cannot revoke an approved authorization~~ Resolved 2026-10-25 (T18): the ERC-1271 gate reads the escrow's status, so a reservation to a closed order is refused by USDC itself; `releaseClosed()` refunds it early. See the hardening section below.

## 2026-10-24: payment adapters (P3.x)

### Built
- `@overflow/schemas`: `PaymentStatusSchema` (purchaseId, path, status, authorizationDigest, nonce, txHash, explorerUrl, authorizationUsed, reason, decodedRevert, checkedAt): the only thing Oracle, Fusion and the UI see.
- `@overflow/payment-client/src/adapters`: `PaymentAdapter` exactly as in the spec; `PaymentRequirementsSchema` (x402 v2 `accepts` entry), `PreparedPaymentSchema`, `PaymentSubmission`; `PurchaseStore` interface + `MemoryPurchaseStore` (Postgres later); `x402.ts` (402 body or `PAYMENT-REQUIRED` header, exact/eip155:84532/USDC quote only, `PAYMENT-SIGNATURE` payload, `PAYMENT-RESPONSE` decoding); `BaseAdapter` (shared `preparePayment`: refuses a quote whose payTo, amount, asset or network differs from the order (`QuoteMismatchError`), signs one EIP-3009 authorization `from = treasury` with the paying node key, PROPOSED → RESERVED; `AuthorizationInFlightError` on any second prepare; `AlreadySubmittedError` on any second submit; every status write goes through `assertTransition`).
- `OverflowFacilitatorAdapter`: `submitPayment` marks PAYMENT_PENDING, POSTs `/settle`; success → ESCROW_FUNDED, decoded revert → REJECTED (`decodedRevert` like `PayeeNotAllowed(0)`), facilitator `status: unknown` / 5xx / unreachable / timeout → PAYMENT_UNKNOWN (never a resign), 409 → the facilitator's original result. `reconcilePayment`: prepared digest + nonce first; receipt of a known hash; USDC `authorizationState`; expiry → FAILED_BEFORE_FUNDING. A used nonce without a hash asks the facilitator, which answers 409 with the original record (idempotent, same digest).
- `CoinbaseFacilitatorAdapter`: validBefore capped inside the reservation window (570 s); `submitPayment` POSTs `/reserve`, then GETs the seller with the x402 payload; `PAYMENT-RESPONSE.success` → ESCROW_FUNDED; a seller/facilitator rejection leaves PAYMENT_PENDING with the reason (the reservation is live until validBefore); timeouts → PAYMENT_UNKNOWN. `reconcilePayment`: `authorizationState` true → ESCROW_FUNDED (Paid is not emitted for reserved payments); unused after expiry → `/release` (RESERVED → RELEASED, PAYMENT_PENDING/UNKNOWN → FAILED_BEFORE_FUNDING; `ReservationLive` → retry later; `NoReservation` → already released).
- `scripts/adapter-demo.ts` (`pnpm demo:adapters`): SIMULATED local x402 seller; the Coinbase-mode seller verifies and settles through `COINBASE_FACILITATOR_URL` (default https://x402.org/facilitator); `--probe-coinbase` only calls that facilitator's `/verify`. Writes `docs/demo-adapters.md`.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm test` | 16 files / 243 tests (adapters 15: quote parsing, prepare + in-flight rule + quote mismatch, Coinbase window cap, settle success/REJECTED/409, **timeout after broadcast → PAYMENT_UNKNOWN → reconcile finds the used nonce and hash with one digest ever**, expiry, reverted receipt, reserve + seller settle, reserve revert, seller rejection then release after expiry, seller timeout then nonce check, RESERVED → RELEASED with ReservationLive/NoReservation) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| `pnpm demo:adapters --probe-coinbase` (read-only, throwaway signer) | `https://x402.org/facilitator/verify` → HTTP 200 `{"isValid":false,"invalidReason":"invalid_exact_evm_signature","payer":"0xd3A7…8291"}` |
| One real purchase per adapter on Base Sepolia | **Not run.** The service cannot boot (no `RELAYER_PASSWORD_FILE`), the live treasury holds 0 USDC and allowlists no payee, and the redeploy with the escrow factory has not happened. |

### P3.4 finding: Coinbase path BLOCKED
The public x402 facilitator verifies the EIP-3009 signature offchain by recovering an EOA and comparing it with `from`. Our `from` is the treasury contract and the signer is a node key, so `/verify` answers `invalid_exact_evm_signature` before anything reaches USDC. Even an ERC-1271 check from the facilitator would fail by design: the treasury answers INVALID to any caller but USDC. Options: (a) a seller middleware that skips the facilitator's verify and settles directly (USDC asks the treasury; that is what our `reserve()` path is built for), (b) a facilitator that submits `transferWithAuthorization` without pre-verifying contract payers, or (c) Coinbase adding contract-payer support. The adapter already models the rejection: PAYMENT_PENDING with the reason, then `/release` after validBefore restores the agent's allowance.

### Notes
- A confirmed payment maps to ESCROW_FUNDED on both paths (the spec machine's only post-payment state); for a third-party seller there is no escrow, and `PaymentStatus.path` says so.
- A `settle` that reverts after the purchase was already PAYMENT_UNKNOWN maps to FAILED_BEFORE_FUNDING (the machine forbids UNKNOWN → REJECTED); from PAYMENT_PENDING it is REJECTED with the decoded error.

## 2026-10-25: spike, Coinbase facilitator with a policy-wallet payer

### Built (throwaway, labeled SPIKE)
- `apps/service/src/sellers/spike/server.ts` (`pnpm spike:seller`): one paid route on `@x402/hono` 2.28.0 + `@x402/evm` `ExactEvmScheme`, facilitator CDP (`@coinbase/x402` auth from `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`) or public (`SPIKE_FACILITATOR=public`).
- `scripts/coinbase-spike.ts` (`pnpm spike:coinbase`): signs `from = treasury`, tries `/reserve`, then the paid route; cases (a) reserve, (b) no reserve, (c) expired; writes `docs/coinbase-feedback.md` with verbatim requests and responses (signatures redacted).

### Verified (real output, 2026-10-25)
| Check | Result |
|---|---|
| CDP facilitator, cases (a)/(b) | 402 `invalid_payload: contract call failed: unable to call contract: execution reverted` |
| CDP facilitator, case (c) | 402 `invalid_exact_evm_payload_authorization_valid_before: valid before expired: 1792901015` |
| public x402.org, all cases | 402 `invalid_exact_evm_signature` |
| CDP `/verify`, EOA valid sig with 0 USDC | same `invalid_payload … execution reverted` (so CDP simulates the transfer onchain) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| case (a) with a live reservation | **not provable**: service cannot boot (no `RELAYER_PASSWORD_FILE`), live treasury has no `reserve()` and 0 USDC; no deploy in this task |

Verdict: Coinbase adapter stays BLOCKED, labeled; demo runs the Overflow path. Details and the one ask for Coinbase in `docs/coinbase-feedback.md`.

## 2026-10-25: hardening pass (stale reservations, sweep reconciliation, fuzz determinism)

### A. Prevent stale reserved payments (T18)
- Path analysed: EIP-3009 `transferWithAuthorization(from = treasury)` → USDC recovers an EOA, fails, falls back to `isValidSignature` on the treasury through a `STATICCALL`. The gate answered MAGIC for any stored reservation until `validBefore`, so an authorization approved while an order was open stayed executable after the order closed; `EscrowClosed` only blocks new `settle()`/`reserve()` calls.
- Fix (status-aware validation, no cancellation transaction): `reserve()` stores `to` and `toIsEscrow`; `isValidSignature` returns INVALID when the reservation's escrow is `Settled`/`Refunded` (one nested `STATICCALL` to `status()`, legal under USDC's staticcall; still `view`). USDC then reverts `FiatTokenV2: invalid signature` and the nonce stays unused. New `releaseClosed(digest)`: anyone, requires a recognized escrow reservation, a closed order and an unused nonce, refunds the whole ancestor chain and deletes the reservation (shared `_close`, so `release()` afterwards reverts `NoReservation`: exactly one release per reservation). Rejected alternative: USDC `cancelAuthorization` needs a treasury signature over the cancel digest (a new transient-flag path), a transaction at the right moment, and marks the nonce used, which would make `release()` refuse the refund. `sweep()` stays as defense in depth.
- New errors `NotEscrowReservation`, `EscrowStillOpen(address)`, `AuthorizationUsed`; struct `Reservation` gained `to`, `toIsEscrow` (storage layout change; redeploy pending anyway). ABIs regenerated; the service decodes the new errors.
- Guarantees that cannot be established: a transfer mined before the closing transaction (including earlier in the same block) is legitimate and cannot be refused (payout/refund already return such surplus to the buyer); only escrow payees have a closure to detect, a direct allowlisted payee has none; the treasury cannot revoke an authorization USDC already executed; the check relies on USDC calling `isValidSignature` at execution time (true for v2.2, confirmed on the fork).

### B. Sweep reconciliation (`apps/service/src/reconciliation/sweeps.ts`)
- Indexes factory `OrderCreated` to learn escrows, escrow `PaidOut`/`Refunded` as terminal markers, the escrow's real `Swept` event, and USDC `Transfer` logs into recognized escrows after their terminal event. `LateArrival` is a service-derived event from that Transfer (labeled `source: "derived"`, `derivedFrom: "USDC Transfer"`); `Swept` is indexed from the escrow log (`source: "chain"`).
- Books balanced `JournalEntry`s keyed `late:<tx>:<logIndex>` (debit escrow-deposit / credit usdc-treasury) and `swept:<tx>:<logIndex>` (debit usdc-treasury / credit escrow-deposit, only for the part matching observed treasury arrivals); a sweep larger than the observed arrivals and USDC from a stranger open `reconciliation-difference` exceptions instead of treasury entries. Entries carry `purchaseId` (from a `PurchaseIndex` by escrow), `txHash` and the new `chainEvent` kinds `Swept`/`LateArrival` in `@overflow/schemas`.
- Confirmation depth (default 3 blocks) before booking; the last 12 blocks are re-scanned every tick and a booked log that vanished gets one reversing entry with `correctsEntryId`; a re-mined log books under its new hash. Idempotent across polls. Never sends a transaction or reads the treasury: spent allowance is untouched by construction (asserted in tests). Recovered status reaches `GET /events` as `Swept` events with `recoveredAtomic`, `outstandingAtomic`, `recovered`.
- Wired at boot when `escrowFactory` is deployed (in-memory ledger, exceptions and purchase index until Postgres). `ChainClient.getLogs` gained an optional topic filter (`event`/`args`) and address lists.

### C. Fuzz determinism
- `RecourseCrypto::test_xorRoundTrip` assumed `chunk.length == 160` on random `bytes`, which the fuzzer almost never produces (intermittent "too many rejects"). It now takes `bytes32[5]` and packs them: every run is a valid, uniformly random 160-byte chunk; no input is rejected and coverage is unchanged.

### Verified (real output, 2026-10-25)
| Check | Result |
|---|---|
| `forge test` | 17 suites, 188 passed, 0 failed, 1 skipped (fork suite skipped off-fork) |
| `pnpm contracts:invariant` | 256 runs x depth 50: all 9 invariants pass, `test_handlerCoverage` and `test_handlerReleaseClosedScenario` pass |
| `pnpm contracts:fork` (live Base Sepolia USDC) | 7 passed, incl. `test_fork_closedEscrow_usdcRejectsReservedAuthorization` |
| `forge test --match-test test_xorRoundTrip --fuzz-seed {1..5} --fuzz-runs 2000` | 5/5 PASS, 2000 runs each |
| `pnpm contracts:gas` | `reserve()` 224,352 (+25.9k: one more storage slot and the `isEscrow` read), `release()` 60,227, `reserve()` to an escrow 242,417, `releaseClosed()` 66,726, `sweep()` 55,904 |
| `pnpm test` | 17 files, 255 tests (reconciliation: 9 incl. complete, partial both ways, stranger USDC, ignored traffic, confirmation depth, reorg correction once, no tx/no treasury read) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |

Coinbase status unchanged: the public-facilitator incompatibility and the unproven CDP settlement stay BLOCKED (`docs/coinbase-feedback.md`); passing adapter and reconciliation tests do not prove live settlement.

Follow-ups: a facilitator route for `releaseClosed` (the Coinbase adapter's reconcile can then refund before `validBefore`); a Postgres ledger behind the `Ledger`/`ExceptionSink` interfaces; the reconciler's purchase index fed by the purchase store.
